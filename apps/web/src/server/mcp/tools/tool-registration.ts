import { runEntityId } from "@cubby/schemas/identifiers";
import { purchaseImportRunExecution } from "@cubby/schemas/purchase-import";
import {
  type McpServer,
  type ToolCallback,
  type CallToolResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { type JSONType, z } from "zod";

import type { McpActionSpec } from "~/contracts/mcp-define";
import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { roundTo } from "~/lib/round-to";
import { getDb } from "~/server/db/helpers";
import { run as runTable } from "~/server/db/schema";
import {
  assertPurchaseAgentAction,
  purchaseAgentRunActions,
} from "~/server/domains/purchase-import/repo/capabilities";
import { toPublicErrorPayload } from "~/server/errors/app-error";
import {
  errorReportingHeaders,
  withErrorReporting,
} from "~/server/errors/report-error";
import {
  type Principal,
  principalWithContext,
} from "~/server/http/authenticate";
import {
  batchInputSchema,
  batchOutputSchema,
  runMcpBatch,
} from "~/server/mcp/batch";
import type { KernelMcpAction } from "~/server/mcp/kernel-actions";
import {
  executePurchaseAgentMutation,
  purchaseAgentSelfGoverned,
} from "~/server/mcp/purchase-agent-protocol";
import { getRequestId } from "~/server/observability/tracing";
import {
  dispatchStartOperation,
  type StartOperationHandlerLoaders,
} from "~/server/operation-runtime/start-operation-dispatch.server";
import {
  type PublicStartOperationError,
  publicStartOperationErrorSchema,
  type StartOperationResult,
  unparsedStartOperationDataSchema,
} from "~/server/operation-runtime/start-operation.contract";
import {
  normalizeStartOperationError,
  type OperationFailureContext,
  type OperationStage,
  runStartOperation,
  withinCompositeBudget,
} from "~/server/operation-runtime/start-operation.server";

import {
  type ActionInputSchema,
  mergeActionInputSchemas,
  requiredFields,
} from "./action-schema";
import {
  describeToolOutputSchema,
  withProgressiveDisclosure,
} from "./progressive-disclosure";
import {
  declareToolInputJsonSchema,
  declareToolOutputSchema,
} from "./tool-catalog";
import { safeToJsonSchema, sdkOutputSchema } from "./tool-json-schema";

/**
 * The MCP SDK adapter registers every generated tool binding
 * (`server/generated/mcp-tools.gen.ts`). Capability groups publish compact
 * `{ action, input }` schemas with a `describe` action; the entity-kernel tools
 * keep detailed schemas. Every action runs through the shared runner
 * (`runStartOperation`): an operation action by id through
 * `dispatchStartOperation`, a kernel verb as an ad hoc runner operation named
 * by its tool action. The runner owns read policy, the per-principal deadline,
 * calendar and freshness bookkeeping; this adapter owns tool grouping,
 * published schemas, output projections, the error shape, and the
 * purchase-agent gate and approval protocol.
 */

const toolArgumentsSchema = z.looseObject({});
const requiredRunExecutionSchema = z.object({
  _runExecution: purchaseImportRunExecution,
});
const emptyInputSchema = z.object({});

export type ToolArguments = z.output<typeof toolArgumentsSchema>;
export type ToolEntityExtractor = (params: ToolArguments) => string | undefined;
export type ToolExtra = Parameters<ToolCallback<typeof emptyInputSchema>>[1];
type JsonObject = Extract<JSONType, { [key: string]: JSONType }>;

type McpOperationId = StartOperationIdOfKind<"query" | "mutation">;

type McpToolBindingAction =
  | {
      readonly kind: "query" | "mutation";
      readonly spec: McpActionSpec;
      readonly kernel: KernelMcpAction;
    }
  | {
      readonly kind: "query" | "mutation";
      readonly spec: McpActionSpec;
      readonly operation: McpOperationId;
    };

export type McpToolBindings = Readonly<
  Record<
    string,
    {
      readonly readOnly: boolean;
      readonly destructive: boolean;
      readonly openWorld: boolean;
      readonly actions: Readonly<Record<string, McpToolBindingAction>>;
    }
  >
>;

export interface McpToolRegistrationRuntime {
  /** Operation handlers by id; tests bind their own. */
  loaders?: StartOperationHandlerLoaders;
  /** The kernel verbs' runner; tests observe its side effects. */
  runStartOperation?: typeof runStartOperation;
  /** A composite unit's overrun write; tests observe it. */
  recordDatabaseWrite?: (operation: string) => Promise<void>;
}

/**
 * The principal `authenticate(request, MCP_AUTH)` minted, which the MCP
 * ingress places in the SDK's untyped authInfo bag.
 */
function principalFromExtra(extra: ToolExtra): Principal {
  const principal = principalInExtra(extra);
  if (!principal) throw new Error("Authenticated MCP principal is missing");
  return principal;
}

export function principalInExtra(extra: ToolExtra): Principal | undefined {
  const candidate: unknown = extra.http?.authInfo?.extra?.principal;
  return isPrincipal(candidate) ? candidate : undefined;
}

const principalFields = z.looseObject({
  channel: z.string(),
  context: z.looseObject({
    db: z.custom((value) => value !== undefined),
    actorContext: z.custom((value) => value !== undefined),
  }),
});
const isPrincipal = (value: unknown): value is Principal =>
  principalFields.safeParse(value).success;

/**
 * A failure the runner already normalized, reported and described. It is
 * thrown to roll back a delegated transaction or to fail one batch item, and
 * rendered as is: normalizing it again would replace its raw cause.
 */
class SettledToolFailure extends Error {
  constructor(readonly detail: PublicStartOperationError) {
    super(detail.message);
    this.name = "SettledToolFailure";
  }
}

const toolEntityExtractors = new WeakMap<
  McpServer,
  Map<string, ToolEntityExtractor>
>();
const toolActionNames = new WeakMap<McpServer, Map<string, Set<string>>>();

export function getToolEntityExtractor(
  server: McpServer,
  name: string,
): ToolEntityExtractor | undefined {
  return toolEntityExtractors.get(server)?.get(name);
}

/** The action names a registered tool accepts, for telemetry naming. */
export function getToolActionNames(
  server: McpServer,
  name: string,
): ReadonlySet<string> | undefined {
  return toolActionNames.get(server)?.get(name);
}

function remember<T>(
  map: WeakMap<McpServer, Map<string, T>>,
  server: McpServer,
  name: string,
  value: T,
) {
  const existing = map.get(server) ?? new Map<string, T>();
  existing.set(name, value);
  map.set(server, existing);
}

function annotationsFor(tool: McpToolBindings[string]): ToolAnnotations {
  return {
    readOnlyHint: tool.readOnly,
    destructiveHint: tool.readOnly ? false : tool.destructive,
    idempotentHint: tool.readOnly,
    openWorldHint: tool.openWorld,
  };
}

/** `outputSchema` is absent when the runner already parsed `data`. */
function structuredSuccess(
  data: unknown,
  outputSchema: z.ZodType | undefined,
): CallToolResult {
  const parsed = z
    .looseObject({})
    .parse(outputSchema ? outputSchema.parse(data) : data);
  return {
    structuredContent: parsed,
    content: [{ type: "text", text: JSON.stringify(parsed) }],
  };
}

/**
 * Refusal details stay in `_meta`, not `structuredContent`. The reference SDK
 * validates structured content against the success schema even for `isError`,
 * so putting `{code, reason}` there makes an ordinary refusal throw McpError.
 * `suffix` is appended after reporting, so it can name the captured Sentry
 * event.
 */
function renderToolError(
  detail: ToolErrorDetail,
  suffix?: (detail: ToolErrorDetail) => string,
): CallToolResult {
  if (suffix) detail.message += suffix(detail);
  return {
    content: [
      {
        type: "text",
        text: `${formatToolError(detail)}\n\n${JSON.stringify(detail)}`,
      },
    ],
    isError: true,
    _meta: { "cubby/error": detail },
  };
}

export const toolErrorDetailSchema = publicStartOperationErrorSchema.partial({
  code: true,
});
export type ToolErrorDetail = z.infer<typeof toolErrorDetailSchema>;

export function describeToolError<T>(
  error: T,
  context?: OperationFailureContext,
  stage: OperationStage = "run",
): ToolErrorDetail {
  if (error instanceof SettledToolFailure) {
    const detail: ToolErrorDetail = structuredClone(error.detail);
    if (context?.batchIndex !== undefined && detail.diagnostics)
      detail.diagnostics.batchIndex = context.batchIndex;
    return detail;
  }
  if (context) {
    const headers = context.headers ?? errorReportingHeaders();
    const detail = normalizeStartOperationError(
      error,
      stage,
      getRequestId(headers),
      {
        ...context,
        headers,
      },
    ).publicError;
    const payload = toPublicErrorPayload(error);
    if (payload.code) {
      detail.code = payload.code;
      detail.reason = payload.reason;
      if (payload.blockers && context.authenticated)
        detail.blockers = payload.blockers;
    }
    return detail;
  }
  const { code, reason } = toPublicErrorPayload(error);
  const message = error instanceof Error ? error.message : String(error);
  const detail: ToolErrorDetail = { message };
  if (code) detail.code = code;
  if (reason) detail.reason = reason;
  return detail;
}

/**
 * What the caller of a call that outlived its principal's budget
 * (`MCP_TOOL_DEADLINE_MS`) reads after the bare overrun: how long, which
 * request and Sentry event, and what it can do next. The error reaches Sentry
 * as the bare overrun; the suffix is appended once the event id is known.
 */
function deadlineSuffix(write: boolean, elapsedMs: number) {
  const next = write
    ? "The write may have completed; re-read the affected records before retrying."
    : "The work may still be running server-side; it is too slow for the connector. Try a narrower request or the web app.";
  return ({ requestId, diagnostics }: ToolErrorDetail) => {
    const request = requestId ? `; Cubby request ${requestId}` : "";
    const sentry = diagnostics?.sentryEventId
      ? `; Sentry ${diagnostics.sentryEventId}`
      : "";
    return ` (answered after ${roundTo(elapsedMs / 1000, 1)}s${request}${sentry}). ${next}`;
  };
}

const overran = (detail: ToolErrorDetail) =>
  detail.reason === "MCP_TOOL_DEADLINE_EXCEEDED";

function formatToolError({ code, reason, message }: ToolErrorDetail): string {
  if (!code) return message;
  return reason ? `${code}: ${message} (${reason})` : `${code}: ${message}`;
}

/**
 * The object (or union of objects) an action's member input is published as,
 * and how tool arguments become the member's own input: a no-input member
 * (`z.undefined()`, `z.null()`) takes no fields, an optional object is
 * published as the object, and a union of objects (a discriminated input such
 * as `run.start`'s purposes) publishes each variant beside `action`.
 */
function memberInput(name: string, schema: z.ZodType) {
  if (schema instanceof z.ZodObject)
    return { object: schema, toMember: (args: ToolArguments) => args };
  const inner =
    schema instanceof z.ZodOptional || schema instanceof z.ZodDefault
      ? schema.unwrap()
      : undefined;
  if (inner instanceof z.ZodObject)
    return { object: inner, toMember: (args: ToolArguments) => args };
  if (
    schema instanceof z.ZodUnion &&
    schema.options.every((option) => option instanceof z.ZodObject)
  )
    return { object: schema, toMember: (args: ToolArguments) => args };
  if (schema instanceof z.ZodUndefined || schema instanceof z.ZodVoid)
    return { object: z.strictObject({}), toMember: () => undefined };
  if (schema instanceof z.ZodNull)
    return { object: z.strictObject({}), toMember: () => null };
  throw new Error(
    `MCP action ${name}: a member input must be an object, an optional object, a union of objects, or no input`,
  );
}

/** `strictFilterInput`'s rule for every `strict` action: name the valid keys. */
function strictInput(name: string, object: z.ZodObject) {
  const valid = Object.keys(object.shape).sort().join(", ");
  return z.strictObject(object.shape, {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `Unknown field ${issue.keys.map((key) => `"${key}"`).join(", ")} for ${name}. Valid fields: ${valid}.`
        : undefined,
  });
}

/**
 * A value an action's own schema produced or its handler returned. The
 * adapter moves it between the action's schemas and hooks, and never reads
 * it except through one of those schemas.
 */
type ActionValue = z.output<z.ZodType>;

/** How one call reaches the runner, under the call's principal. */
type ActionCall = {
  principal: Principal;
  headers: Headers | undefined;
  signal: AbortSignal;
  runtime: McpToolRegistrationRuntime;
};

type CompiledAction = {
  name: string;
  kind: "query" | "mutation";
  spec: McpActionSpec;
  batch: boolean;
  /** The member's own input declares the purchase-agent `_runExecution` envelope. */
  keepsRunExecution: boolean;
  input: z.ZodType;
  /** Published aliases leave the member operation contract unchanged. */
  publishedInput?: z.ZodType;
  /** Tool arguments (minus `action` and the run envelope) → action input. */
  prepareInput: (args: ToolArguments) => ToolArguments;
  output: z.ZodType;
  /** Whether the runner's output parse leaves the published shape unchecked. */
  parsesOutput: boolean;
  /** A composite runs its inner runner calls inside one budget of its own. */
  composite: boolean;
  telemetryEntity: (input: ActionValue) => string | undefined;
  /**
   * Run one call. A runner failure is thrown as a {@link SettledToolFailure},
   * so a delegated transaction rolls back and a batch item fails alone.
   */
  invoke: (
    input: ActionValue,
    call: ActionCall,
    toolAction: string,
    execution: z.output<typeof purchaseImportRunExecution> | undefined,
    /** The tool arguments `input` parsed from, for a member the runner parses. */
    raw: ToolArguments,
  ) => Promise<ActionValue>;
};

const settled = <T>(result: StartOperationResult<T>): T => {
  if (!result.ok) throw new SettledToolFailure(result.error);
  return result.data;
};

/** An operation action's published schemas: its contract member's own. */
const memberSchemas = z.object({
  input: z.custom<z.ZodType>(),
  output: z.custom<z.ZodType>(),
});

const entityOf = z.object({ entity: z.string() });
// Inputs have already been parsed into domain values (including Dates).
// JSON validation here would discard the entire batch before attribution.
const batchItems = z.object({ items: z.array(z.unknown()) });
const commandItems = z.object({ commands: z.array(z.unknown()) });

/** The first item of a batch input, whose entity names the call for telemetry. */
const firstItem = (input: ActionValue) =>
  batchItems.safeParse(input).data?.items[0] ??
  commandItems.safeParse(input).data?.commands[0];

/** The tool reserves `action`; a member's discriminator uses `operationAction`. */
function publishMemberAction<T extends z.core.$ZodType>(
  input: T,
): T | z.ZodType {
  if (input instanceof z.ZodObject && "action" in input.shape) {
    if ("operationAction" in input.shape)
      throw new Error(
        "MCP member input declares both action and operationAction",
      );
    return input
      .omit({ action: true })
      .extend({ operationAction: input.shape.action });
  }
  if (input instanceof z.ZodUnion) {
    const options = input.options.map(publishMemberAction);
    if (options.every((option, index) => option === input.options[index]))
      return input;
    return z.union([options[0]!, options[1]!, ...options.slice(2)]);
  }
  return input;
}

function compileAction(
  toolAction: string,
  binding: McpToolBindingAction,
): CompiledAction {
  const { spec, kind } = binding;

  if ("kernel" in binding) {
    const { kernel } = binding;
    return {
      name: toolAction,
      kind,
      spec,
      batch: false,
      keepsRunExecution: false,
      input: kernel.input,
      prepareInput: (args) =>
        kernel.verb ? { ...args, action: kernel.verb } : args,
      output: kernel.output,
      parsesOutput: true,
      composite: false,
      telemetryEntity: (input) =>
        spec.telemetryEntity?.(input) ??
        entityOf.safeParse(input).data?.entity ??
        entityOf.safeParse(firstItem(input)).data?.entity,
      // The verb runs as an ad hoc runner operation named by its tool action;
      // its input was already parsed, so the runner parses only its output.
      invoke: async (input, call, name, execution) =>
        settled(
          await (call.runtime.runStartOperation ?? runStartOperation)({
            operation: { id: name, kind },
            type: kind,
            input,
            inputSchema: z.unknown(),
            outputSchema: kernel.output,
            request: {
              principal: call.principal,
              headers: call.headers ?? new Headers(),
              signal: call.signal,
              modelBacked: spec.modelBacked,
            },
            run: (context, parsed) =>
              kernel.run(
                parsed,
                principalWithContext(call.principal, context),
                name,
                execution,
              ),
          }),
        ),
    };
  }

  const operation = memberSchemas.parse(spec.op);
  const operationId = binding.operation;
  const { object, toMember } = memberInput(toolAction, operation.input);
  let published = object;
  if (spec.strict) {
    if (!(object instanceof z.ZodObject))
      throw new Error(
        `MCP action ${toolAction}: only an object input can be strict`,
      );
    published = strictInput(toolAction, object);
  }
  const memberOutput = spec.output ?? operation.output;
  // The runner parses the member's own input and output from the raw tool
  // arguments; the published parse here only names fields, refuses unknown
  // keys, and feeds telemetry and the purchase-agent fingerprint.
  const runMember = async (raw: ActionValue, call: ActionCall) => {
    const member = toMember(z.looseObject({}).parse(raw ?? {}));
    const result = settled<ActionValue>(
      await dispatchStartOperation(
        {
          operation: operationId,
          input: unparsedStartOperationDataSchema.parse(member),
          request: {
            principal: call.principal,
            headers: call.headers ?? new Headers(),
            signal: call.signal,
            modelBacked: spec.modelBacked,
          },
        },
        call.runtime.loaders,
      ),
    );
    return spec.project ? spec.project(result, member) : result;
  };

  if (spec.batch) {
    const batch = spec.batch;
    const input = batchInputSchema({
      key: "items",
      itemInput: published,
      maxItems: batch.maxItems,
      resultDetail: batch.resultDetail,
      uniqueIds: batch.uniqueIds,
    });
    const parsedBatch = z.object({
      items: z.array(published),
      resultDetail: z.enum(["summary", "full"]),
    });
    return {
      name: toolAction,
      kind,
      spec,
      batch: true,
      keepsRunExecution: false,
      input,
      prepareInput: (args) => args,
      output: batchOutputSchema(memberOutput),
      parsesOutput: false,
      composite: true,
      telemetryEntity: (value) => {
        const item = firstItem(value);
        return (
          spec.telemetryEntity?.(item) ?? entityOf.safeParse(item).data?.entity
        );
      },
      invoke: (value, call, name, execution, raw) => {
        const parsed = parsedBatch.parse(value);
        const rawItems = batchItems.parse(raw).items;
        return runMcpBatch(
          {
            name,
            key: "items",
            itemInput: published,
            itemOutput: memberOutput,
            reference: batch.reference,
            mutation: kind === "mutation",
            run: (_item, principal, _detail, index) =>
              runMember(rawItems[index], { ...call, principal }),
          },
          {
            items: parsed.items,
            resultDetail: parsed.resultDetail,
            execution,
          },
          call.principal,
        );
      },
    };
  }

  const publishedInput = publishMemberAction(published);
  return {
    name: toolAction,
    kind,
    spec,
    batch: false,
    publishedInput,
    keepsRunExecution:
      published instanceof z.ZodObject && "_runExecution" in published.shape,
    input: published,
    prepareInput: (args) => {
      if (publishedInput === published) return args;
      const { operationAction, ...member } = args;
      return { ...member, action: operationAction };
    },
    output: memberOutput,
    // A projection changes the member's shape after the runner's parse.
    parsesOutput: !spec.project,
    composite: false,
    telemetryEntity: (input) =>
      spec.telemetryEntity?.(input) ?? entityOf.safeParse(input).data?.entity,
    invoke: (_input, call, _name, _execution, raw) => runMember(raw, call),
  };
}

type CompiledTool = {
  uiResourceUri?: string;
  name: string;
  declaration: string;
  description: string;
  annotations: ToolAnnotations;
  actions: Map<string, CompiledAction>;
  actionJson: Map<string, JsonObject>;
  compact: boolean;
  inputJsonSchema: JsonObject;
  output: z.ZodType;
};

const runExecutionJsonSchema = safeToJsonSchema(
  purchaseImportRunExecution,
  "input",
);

function actionJsonSchema(action: CompiledAction): JsonObject {
  return safeToJsonSchema(action.publishedInput ?? action.input, "input");
}

const shortName = (action: CompiledAction) => action.name.split(".")[1]!;

/** The tool description: its purpose, then one line per action. */
function toolDescription(
  declaration: string,
  actions: ReadonlyArray<{ action: CompiledAction; json: JsonObject }>,
  compact = false,
): string {
  const lines = actions.map(({ action, json }) => {
    const required = requiredFields(json);
    const suffix =
      required.length > 0 ? ` Requires: ${required.join(", ")}.` : "";
    return `- ${shortName(action)}: ${action.spec.description}${suffix}`;
  });
  return compact
    ? `${declaration}\n\nCall with {action, input}. Use action \`describe\` with input.actions to inspect full action schemas. Actions:\n${lines.join("\n")}`
    : `${declaration}\n\nCall with {action, ...fields}. Actions:\n${lines.join("\n")}`;
}

function toolSchema(
  declaration: string,
  actions: ReadonlyArray<{ action: CompiledAction; json: JsonObject }>,
  runExecution = true,
  compact = false,
) {
  if (compact) {
    const actionNames = actions.map(({ action }) => shortName(action));
    return {
      description: toolDescription(declaration, actions, true),
      inputJsonSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [...actionNames, "describe"],
            description:
              "Which action to run, or describe to inspect action schemas.",
          },
          input: {
            type: "object",
            description:
              "Action-specific input. For describe, pass { actions: [actionName, ...] }.",
            properties: {
              actions: {
                type: "array",
                items: { type: "string", enum: actionNames },
                minItems: 1,
              },
            },
            additionalProperties: true,
          },
          ...(runExecution ? { _runExecution: runExecutionJsonSchema } : {}),
        },
        required: ["action", "input"],
        additionalProperties: false,
      } satisfies JsonObject,
    };
  }
  return {
    description: toolDescription(declaration, actions),
    inputJsonSchema: mergeActionInputSchemas(
      actions.map(({ action, json }): ActionInputSchema => ({
        name: shortName(action),
        description: action.spec.description,
        schema: json,
      })),
      runExecution ? { _runExecution: runExecutionJsonSchema } : {},
    ),
  };
}

/**
 * Whether a purchase agent's call of `action` reads `_runExecution`: its
 * writer takes the envelope, or the adapter's replay wrapper requires it for a
 * write the writer does not govern (see the tool callback). Reads and
 * self-governed writers without it (mail.*) are bound by the delegation alone.
 */
const agentReadsRunExecution = (action: CompiledAction) =>
  action.keepsRunExecution ||
  (action.kind === "mutation" && !selfGoverned(action));

const narrowedSchemas = new Map<string, ReturnType<typeof toolSchema>>();

/**
 * The description and input schema of `tool` limited to `allowed` actions
 * (`${tool}.${action}`), or null when none is allowed. The purchase agent's
 * catalog is narrowed this way: the agent mounts whole tools and resends every
 * mounted schema on each model call, so an agent sees only its actions, and
 * the `_runExecution` envelope only when one of them reads it.
 */
export function narrowedToolSchema(
  tool: CompiledTool,
  allowed: ReadonlySet<string>,
): ReturnType<typeof toolSchema> | null {
  const actions = [...tool.actions.values()].filter((action) =>
    allowed.has(action.name),
  );
  if (actions.length === 0) return null;
  const key = actions.map((action) => action.name).join("|");
  const cached = narrowedSchemas.get(key);
  if (cached) return cached;
  const schema = toolSchema(
    tool.declaration,
    actions.map((action) => ({
      action,
      json: tool.actionJson.get(shortName(action))!,
    })),
    actions.some(agentReadsRunExecution),
    tool.compact,
  );
  narrowedSchemas.set(key, schema);
  return schema;
}

const compiledTools = new WeakMap<McpToolBindings, CompiledTool[]>();

/**
 * Compile the bindings once per isolate: the merged JSON Schema of `entity`
 * alone is several hundred kilobytes of work, and `createMcpServer` runs per
 * request.
 */
function compileTools(
  bindings: McpToolBindings,
  descriptions: Readonly<Record<string, { description: string }>>,
): CompiledTool[] {
  const cached = compiledTools.get(bindings);
  if (cached) return cached;
  const tools = Object.entries(bindings).map(([name, tool]): CompiledTool => {
    const compact = !Object.values(tool.actions).some(
      (binding) => "kernel" in binding,
    );
    const actions = new Map(
      Object.entries(tool.actions).map(([action, binding]) => [
        action,
        compileAction(`${name}.${action}`, binding),
      ]),
    );
    const withJson = [...actions.values()].map((action) => ({
      action,
      json: actionJsonSchema(action),
    }));
    const outputs = [
      ...new Set([...actions.values()].map((action) => action.output)),
    ];
    const declaration = descriptions[name]?.description ?? name;
    const uiResources = [
      ...new Set(
        Object.values(tool.actions).flatMap(({ spec }) =>
          spec.uiResourceUri ? [spec.uiResourceUri] : [],
        ),
      ),
    ];
    if (
      uiResources.length > 1 ||
      (uiResources.length && Object.keys(tool.actions).length !== 1)
    )
      throw new Error(
        `MCP render tool ${name} must own one action and one UI resource`,
      );
    return {
      name,
      uiResourceUri: uiResources[0],
      declaration,
      ...toolSchema(declaration, withJson, true, compact),
      annotations: annotationsFor(tool),
      actions,
      compact,
      actionJson: new Map(
        withJson.map(({ action, json }) => [shortName(action), json]),
      ),
      output: compact
        ? z.union([
            describeToolOutputSchema,
            // SAFETY: generated compact tools always have at least one action output.
            ...(outputs as [z.ZodType, ...z.ZodType[]]),
          ])
        : outputs.length === 1
          ? outputs[0]!
          : // SAFETY: a tool has at least one action; zod needs a tuple type.
            z.union(outputs as [z.ZodType, z.ZodType, ...z.ZodType[]]),
    };
  });
  compiledTools.set(bindings, tools);
  return tools;
}

/**
 * Whether the purchase agent's own writer governs its run protocol (replay,
 * target checks, per-item operation ids) so the adapter must not wrap the
 * call in the generic approval flow.
 */
const selfGoverned = (action: CompiledAction) =>
  action.batch ||
  action.name === "entity.commands" ||
  purchaseAgentSelfGoverned(action.name);

/**
 * The tool arguments an action parses: everything but `action`, and the
 * `_runExecution` envelope only when the action's writer reads it from its
 * own input (the purchase-import and photo-run writers); otherwise the
 * adapter keeps it for the approval protocol.
 */
function actionArguments(
  action: CompiledAction,
  params: ToolArguments,
  signedGeneration: string | undefined,
): ToolArguments {
  const { action: _action, _runExecution, ...args } = params;
  if (!action.keepsRunExecution || _runExecution === undefined) return args;
  // Only the run-bound delegation's signature names a coordinator
  // generation; a caller-written value is never trusted.
  const { generation: _claimed, ...envelope } = z
    .looseObject({ generation: z.unknown().optional() })
    .parse(_runExecution);
  return {
    ...args,
    _runExecution: signedGeneration
      ? { ...envelope, generation: signedGeneration }
      : envelope,
  };
}

export function registerMcpTools(
  server: McpServer,
  bindings: McpToolBindings,
  descriptions: Readonly<Record<string, { description: string }>>,
  runtime: McpToolRegistrationRuntime = {},
): void {
  for (const tool of compileTools(bindings, descriptions))
    registerCompiledTool(server, tool, runtime);
}

function registerCompiledTool(
  server: McpServer,
  tool: CompiledTool,
  runtime: McpToolRegistrationRuntime,
): void {
  const actionNames = [...tool.actions.keys()];
  const actionOf = (params: ToolArguments) => {
    const name = z.object({ action: z.string() }).safeParse(params)
      .data?.action;
    return name === undefined ? undefined : tool.actions.get(name);
  };
  remember(toolActionNames, server, tool.name, new Set(actionNames));
  remember(toolEntityExtractors, server, tool.name, (params) => {
    const action = actionOf(params);
    if (!action) return undefined;
    return action.telemetryEntity(
      action.input.parse(
        action.prepareInput(actionArguments(action, params, undefined)),
      ),
    );
  });
  declareToolInputJsonSchema(server, tool.name, tool.inputJsonSchema);
  declareToolOutputSchema(server, tool.name, tool.output);

  const callback = async (
    params: ToolArguments,
    extra: ToolExtra,
  ): Promise<CallToolResult> =>
    withErrorReporting(async () => {
      const startedAt = performance.now();
      let stage: OperationStage = "input";
      let entity: string | undefined;
      let operationName = tool.name;
      let mutation = false;
      const answer = <T>(error: T) => {
        const detail = describeToolError(
          error,
          { operation: operationName, authenticated: true, entity },
          stage,
        );
        return renderToolError(
          detail,
          overran(detail)
            ? deadlineSuffix(
                mutation,
                Math.round(performance.now() - startedAt),
              )
            : undefined,
        );
      };
      try {
        const action = actionOf(params);
        if (!action)
          throw new Error(
            `${tool.name} needs an \`action\`: one of ${actionNames.join(", ")}.`,
          );
        operationName = action.name;
        mutation = action.kind === "mutation";
        const principal = principalFromExtra(extra);
        const { delegation } = principal;
        let execution = purchaseImportRunExecution
          .optional()
          .parse(params._runExecution);
        const raw = action.prepareInput(
          actionArguments(action, params, delegation?.generation),
        );
        const input = action.input.parse(raw);
        entity = action.telemetryEntity(input);
        stage = "context";
        if (delegation)
          await assertPurchaseAgentAction(
            principal.context.db,
            delegation.runId,
            action.name,
            mutation,
            entity,
          );
        const governed = selfGoverned(action);
        // A self-governed writer that reads the envelope must name the
        // delegated Run; one without it (mail.*) is bound by the actor's
        // delegated runId instead.
        if (delegation && mutation && governed && action.keepsRunExecution) {
          if (!execution) {
            stage = "input";
            execution = requiredRunExecutionSchema.parse(params, {
              error: () =>
                "Purchase-agent writes require the run execution envelope",
            })._runExecution;
          }
          const [delegatedRun] = await getDb(principal.context.db)
            .select({ id: runTable.id })
            .from(runTable)
            .where(eq(runTable.id, runEntityId.parse(delegation.runId)))
            .limit(1);
          if (delegatedRun?.id !== execution.runId)
            throw new Error(
              "Purchase-agent run execution does not match its delegation",
            );
        }
        stage = "run";
        const call: ActionCall = {
          principal,
          headers: errorReportingHeaders(),
          signal: extra.mcpReq.signal,
          runtime,
        };
        // A delegated write the writer does not govern runs in one
        // transaction with its approval and replay record.
        const transactional = delegation && mutation && !governed;
        const invoke = (unit: ActionCall) => {
          if (!transactional)
            return action.invoke(input, unit, action.name, execution, raw);
          if (!execution) {
            stage = "input";
            execution = requiredRunExecutionSchema.parse(params, {
              error: () =>
                "Purchase-agent writes require the run execution envelope",
            })._runExecution;
          }
          return executePurchaseAgentMutation({
            principal: unit.principal,
            delegation,
            toolName: action.name,
            args: input,
            execution,
            run: (inTransaction) =>
              action.invoke(
                input,
                { ...unit, principal: inTransaction },
                action.name,
                execution,
                raw,
              ),
          });
        };
        // One call is budgeted by the runner. A composite spends one budget
        // around all of its inner calls: none of them may answer a deadline
        // from inside a delegated transaction.
        const outcome =
          action.composite || transactional
            ? await withinCompositeBudget<
                { ok: true; value: ActionValue } | { ok: false; error: Error }
              >({
                principal,
                name: action.name,
                kind: action.kind,
                modelBacked: action.spec.modelBacked,
                signal: call.signal,
                recordWrite: runtime.recordDatabaseWrite,
                work: async (unbudgeted, signal) => ({
                  ok: true,
                  value: await invoke({
                    ...call,
                    principal: unbudgeted,
                    signal,
                  }),
                }),
                expired: (error) => ({ ok: false, error }),
              })
            : { ok: true as const, value: await invoke(call) };
        if (!outcome.ok) return answer(outcome.error);
        stage = "output";
        return structuredSuccess(
          outcome.value,
          action.parsesOutput ? undefined : action.output,
        );
      } catch (error) {
        return answer(error);
      }
    });

  const registeredInput = z.looseObject({
    action: z.string(),
    input: z.looseObject({}).optional(),
  });
  const registeredCallback = tool.compact
    ? withProgressiveDisclosure(callback, tool, async (extra) => {
        const principal = principalInExtra(extra);
        if (!principal?.delegation) return undefined;
        const { allowed } = await purchaseAgentRunActions(
          principal.context.db,
          principal.delegation.runId,
        );
        return new Set(allowed);
      })
    : callback;
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: registeredInput,
      outputSchema: sdkOutputSchema(tool.output),
      annotations: tool.annotations,
      ...(tool.uiResourceUri
        ? { _meta: { ui: { resourceUri: tool.uiResourceUri } } }
        : {}),
    },
    // SAFETY: the SDK's conditional ToolCallback type does not reduce for a
    // loose object. This callback accepts that argument bag, parses each
    // action's own schema, preserves ToolExtra, and returns a CallToolResult
    // in every branch.
    registeredCallback as ToolCallback<typeof registeredInput>,
  );
}

/** Compiled tools for catalog narrowing (see `narrowedToolList`). */
export function compiledMcpTools(
  bindings: McpToolBindings,
  descriptions: Readonly<Record<string, { description: string }>>,
): readonly CompiledTool[] {
  return compileTools(bindings, descriptions);
}

export type { CompiledTool };
