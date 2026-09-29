import { mcpAppResourceUriForTool } from "@cubby/mcp-apps/metadata";
import { runEntityId } from "@cubby/schemas/identifiers";
import { purchaseImportRunExecution } from "@cubby/schemas/purchase-import";
import type {
  McpServer,
  ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { type JSONType, z } from "zod";

import type { McpActionSpec } from "~/contracts/mcp-define";
import type { StartOperationId } from "~/lib/start-operation-observability";
import { scheduleCalendarFeedDirty } from "~/server/calendar/client";
import { recordDatabaseWrite } from "~/server/database-freshness/client";
import { run as runTable } from "~/server/db/schema";
import { toPublicErrorPayload } from "~/server/errors/app-error";
import {
  errorReportingHeaders,
  withErrorReporting,
} from "~/server/errors/report-error";
import {
  batchInputSchema,
  batchOutputSchema,
  runMcpBatch,
} from "~/server/mcp/batch";
import type { KernelMcpAction } from "~/server/mcp/kernel-actions";
import { getEntityKernelContext } from "~/server/mcp/kernel-context";
import { McpOperationContext } from "~/server/mcp/operation-context";
import {
  executePurchaseAgentMutation,
  purchaseAgentSelfGoverned,
  trustedPurchaseAgent,
} from "~/server/mcp/purchase-agent-protocol";
import type { DirectOperationRun } from "~/server/operation-domain.server";
import { assertPurchaseAgentAction } from "~/server/purchase-import/capabilities";
import { type ReadPolicy, readPolicyFor } from "~/server/read-policy";
import { getDb } from "~/server/repo/database-helpers";
import type { AuthenticatedRequestContext } from "~/server/request-context";
import { publicStartOperationErrorSchema } from "~/server/start-operation.contract";
import {
  normalizeStartOperationError,
  type OperationFailureContext,
  type OperationStage,
} from "~/server/start-operation.server";
import { getRequestId } from "~/server/tracing";

import {
  type ActionInputSchema,
  mergeActionInputSchemas,
  requiredFields,
} from "./action-schema";
import {
  declareToolInputJsonSchema,
  declareToolOutputSchema,
} from "./tool-catalog";
import { safeToJsonSchema, sdkOutputSchema } from "./tool-json-schema";

/**
 * The MCP SDK adapter: registers every generated tool binding
 * (`server/generated/mcp-tools.gen.ts`) as one `{ action, ...input }` tool, and
 * owns what every call shares — read-policy selection, the purchase-agent
 * gate and approval protocol, output validation, error shape, calendar and
 * freshness bookkeeping.
 */

export type McpRequestContext = AuthenticatedRequestContext;

const toolArgumentsSchema = z.looseObject({});
const emptyInputSchema = z.object({});

export type ToolArguments = z.output<typeof toolArgumentsSchema>;
export type ToolEntityExtractor = (params: ToolArguments) => string | undefined;
export type ToolExtra = Parameters<ToolCallback<typeof emptyInputSchema>>[1];
type JsonObject = Extract<JSONType, { [key: string]: JSONType }>;

type McpToolBindingAction =
  | {
      readonly kind: "query" | "mutation";
      readonly spec: McpActionSpec;
      readonly kernel: KernelMcpAction;
    }
  | {
      readonly kind: "query" | "mutation";
      readonly spec: McpActionSpec;
      readonly operation: StartOperationId;
      readonly run: DirectOperationRun | undefined;
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
  markCalendarDirty(reason: string): void;
  recordDatabaseWrite?(source: string): Promise<void>;
}

const productionMcpToolRegistrationRuntime: McpToolRegistrationRuntime = {
  markCalendarDirty: (reason) => scheduleCalendarFeedDirty(reason),
  recordDatabaseWrite,
};

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

function uiToolMeta(toolName: string) {
  const resourceUri = mcpAppResourceUriForTool(toolName);
  if (!resourceUri) return undefined;
  return { ui: { resourceUri } };
}

function annotationsFor(tool: McpToolBindings[string]): ToolAnnotations {
  return {
    readOnlyHint: tool.readOnly,
    destructiveHint: tool.readOnly ? false : tool.destructive,
    idempotentHint: tool.readOnly,
    openWorldHint: tool.openWorld,
  };
}

function structuredSuccess(
  data: unknown,
  outputSchema: z.ZodType,
): CallToolResult {
  const parsed = z.looseObject({}).parse(outputSchema.parse(data));
  return {
    structuredContent: parsed,
    content: [{ type: "text", text: JSON.stringify(parsed) }],
  };
}

/**
 * Refusal details stay in `_meta`, not `structuredContent`. The reference SDK
 * validates structured content against the success schema even for `isError`,
 * so putting `{code, reason}` there makes an ordinary refusal throw McpError.
 */
function structuredError<T>(
  error: T,
  context: OperationFailureContext,
  stage: OperationStage,
): CallToolResult {
  const detail = describeToolError(error, context, stage);
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

function formatToolError({ code, reason, message }: ToolErrorDetail): string {
  if (!code) return message;
  return reason ? `${code}: ${message} (${reason})` : `${code}: ${message}`;
}

const present = z.custom((value) => value !== undefined);
const authenticatedRequestFields = z.looseObject({
  db: present,
  actorContext: present,
});
const requestContextSchema = z.custom<McpRequestContext>(
  (value) => authenticatedRequestFields.safeParse(value).success,
  "expected an authenticated request context",
);

/** The policy-selected request context `prepareToolExtra` placed in the SDK's untyped authInfo bag. */
function getRequestContext(extra: ToolExtra): McpRequestContext {
  const candidate = extra.authInfo?.extra?.requestContext;
  if (candidate === undefined)
    throw new Error("Authenticated request context is missing");
  return requestContextSchema.parse(candidate);
}

export function operationContextFromExtra(
  extra: ToolExtra,
): McpOperationContext | undefined {
  const candidate = extra.authInfo?.extra?.operationContext;
  return candidate instanceof McpOperationContext ? candidate : undefined;
}

async function prepareToolExtra(
  extra: ToolExtra,
  policy: ReadPolicy,
): Promise<ToolExtra> {
  const operationContext = operationContextFromExtra(extra);
  if (!operationContext || !extra.authInfo) return extra;
  const prepared = await operationContext.prepare(policy);
  return {
    ...extra,
    authInfo: {
      ...extra.authInfo,
      extra: { ...extra.authInfo?.extra, ...prepared },
    },
  };
}

/**
 * The object an action's member input is published as, and how tool
 * arguments become the member's own input: a no-input member (`z.undefined()`,
 * `z.null()`) takes no fields, and an optional object is published as the
 * object.
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
  if (schema instanceof z.ZodUndefined || schema instanceof z.ZodVoid)
    return { object: z.strictObject({}), toMember: () => undefined };
  if (schema instanceof z.ZodNull)
    return { object: z.strictObject({}), toMember: () => null };
  throw new Error(
    `MCP action ${name}: a member input must be an object, an optional object, or no input`,
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
type ActionReadPolicy = McpActionSpec["readPolicy"];

const isReadPolicyFunction = (
  policy: ActionReadPolicy,
): policy is (input: ActionValue) => ReadPolicy => typeof policy === "function";

type CompiledAction = {
  name: string;
  kind: "query" | "mutation";
  spec: McpActionSpec;
  batch: boolean;
  /** The member's own input declares the purchase-agent `_runExecution` envelope. */
  keepsRunExecution: boolean;
  input: z.ZodType;
  /** Tool arguments (minus `action` and the run envelope) → action input. */
  prepareInput: (args: ToolArguments) => ToolArguments;
  output: z.ZodType;
  readPolicy: (input: ActionValue) => ReadPolicy;
  telemetryEntity: (input: ActionValue) => string | undefined;
  invoke: (
    input: ActionValue,
    extra: ToolExtra,
    toolAction: string,
    execution: z.output<typeof purchaseImportRunExecution> | undefined,
  ) => Promise<ActionValue>;
};

const entityOf = z.object({ entity: z.string() });
const batchItems = z.object({ items: z.array(z.json()) });
const commandItems = z.object({ commands: z.array(z.json()) });

/** The first item of a batch input, whose entity names the call for telemetry. */
const firstItem = (input: ActionValue) =>
  batchItems.safeParse(input).data?.items[0] ??
  commandItems.safeParse(input).data?.commands[0];

function compileAction(
  toolAction: string,
  binding: McpToolBindingAction,
): CompiledAction {
  const { spec, kind } = binding;
  const readPolicyOf =
    (fallback: ReadPolicy) =>
    (input: ActionValue): ReadPolicy =>
      kind === "mutation"
        ? "strong"
        : isReadPolicyFunction(spec.readPolicy)
          ? spec.readPolicy(input)
          : (spec.readPolicy ?? fallback);

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
      readPolicy: readPolicyOf("context"),
      telemetryEntity: (input) =>
        spec.telemetryEntity?.(input) ??
        entityOf.safeParse(input).data?.entity ??
        entityOf.safeParse(firstItem(input)).data?.entity,
      invoke: (input, extra, name, execution) =>
        kernel.run(input, extra, name, execution),
    };
  }

  const operation = binding.run;
  if (!operation) throw new Error(`${toolAction} has no bound handler`);
  const { object, toMember } = memberInput(toolAction, operation.input);
  const published = spec.strict ? strictInput(toolAction, object) : object;
  const memberOutput = spec.output ?? operation.output;
  const runMember = async (input: ActionValue, extra: ToolExtra) => {
    const member = toMember(z.looseObject({}).parse(input ?? {}));
    const result = await operation.run(
      { ...getRequestContext(extra), signal: extra.signal },
      member,
    );
    return spec.project ? spec.project(result, member) : result;
  };
  const readPolicy = readPolicyOf(readPolicyFor(binding.operation, kind));

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
      readPolicy,
      telemetryEntity: (value) => {
        const item = firstItem(value);
        return (
          spec.telemetryEntity?.(item) ?? entityOf.safeParse(item).data?.entity
        );
      },
      invoke: (value, extra, name, execution) => {
        const parsed = parsedBatch.parse(value);
        return runMcpBatch(
          {
            name,
            key: "items",
            itemInput: published,
            itemOutput: memberOutput,
            reference: batch.reference,
            mutation: kind === "mutation",
            run: runMember,
          },
          {
            items: parsed.items,
            resultDetail: parsed.resultDetail,
            execution,
          },
          extra,
        );
      },
    };
  }

  return {
    name: toolAction,
    kind,
    spec,
    batch: false,
    keepsRunExecution: "_runExecution" in published.shape,
    input: published,
    prepareInput: (args) => args,
    output: memberOutput,
    readPolicy,
    telemetryEntity: (input) =>
      spec.telemetryEntity?.(input) ?? entityOf.safeParse(input).data?.entity,
    invoke: (input, extra) => runMember(input, extra),
  };
}

type CompiledTool = {
  name: string;
  declaration: string;
  description: string;
  annotations: ToolAnnotations;
  actions: Map<string, CompiledAction>;
  actionJson: Map<string, JsonObject>;
  inputJsonSchema: JsonObject;
  output: z.ZodType;
};

const runExecutionJsonSchema = safeToJsonSchema(
  purchaseImportRunExecution,
  "input",
);

function actionJsonSchema(action: CompiledAction): JsonObject {
  return safeToJsonSchema(action.input, "input");
}

const shortName = (action: CompiledAction) => action.name.split(".")[1]!;

/** The tool description: its purpose, then one line per action. */
function toolDescription(
  declaration: string,
  actions: ReadonlyArray<{ action: CompiledAction; json: JsonObject }>,
): string {
  const lines = actions.map(({ action, json }) => {
    const required = requiredFields(json);
    const suffix =
      required.length > 0 ? ` Requires: ${required.join(", ")}.` : "";
    return `- ${shortName(action)}: ${action.spec.description}${suffix}`;
  });
  return `${declaration}\n\nCall with {action, ...fields}. Actions:\n${lines.join("\n")}`;
}

function toolSchema(
  declaration: string,
  actions: ReadonlyArray<{ action: CompiledAction; json: JsonObject }>,
) {
  return {
    description: toolDescription(declaration, actions),
    inputJsonSchema: mergeActionInputSchemas(
      actions.map(({ action, json }): ActionInputSchema => ({
        name: shortName(action),
        description: action.spec.description,
        schema: json,
      })),
      { _runExecution: runExecutionJsonSchema },
    ),
  };
}

const narrowedSchemas = new Map<string, ReturnType<typeof toolSchema>>();

/**
 * The description and input schema of `tool` limited to `allowed` actions
 * (`${tool}.${action}`), or null when none is allowed. The purchase agent's
 * catalog is narrowed this way: Flue mounts whole tools and resends every
 * mounted schema on each model call, so an agent sees only its actions.
 */
export function narrowedToolSchema(
  tool: CompiledTool,
  allowed: ReadonlySet<string>,
): ReturnType<typeof toolSchema> | null {
  const actions = [...tool.actions.values()].filter((action) =>
    allowed.has(action.name),
  );
  if (actions.length === 0) return null;
  if (actions.length === tool.actions.size)
    return {
      description: tool.description,
      inputJsonSchema: tool.inputJsonSchema,
    };
  const key = actions.map((action) => action.name).join("|");
  const cached = narrowedSchemas.get(key);
  if (cached) return cached;
  const schema = toolSchema(
    tool.declaration,
    actions.map((action) => ({
      action,
      json: tool.actionJson.get(shortName(action))!,
    })),
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
    return {
      name,
      declaration,
      ...toolSchema(declaration, withJson),
      annotations: annotationsFor(tool),
      actions,
      actionJson: new Map(
        withJson.map(({ action, json }) => [shortName(action), json]),
      ),
      output:
        outputs.length === 1
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
): ToolArguments {
  const { action: _action, _runExecution, ...args } = params;
  return action.keepsRunExecution && _runExecution !== undefined
    ? { ...args, _runExecution }
    : args;
}

export function registerMcpTools(
  server: McpServer,
  bindings: McpToolBindings,
  descriptions: Readonly<Record<string, { description: string }>>,
  runtime: McpToolRegistrationRuntime = productionMcpToolRegistrationRuntime,
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
      action.input.parse(action.prepareInput(actionArguments(action, params))),
    );
  });
  declareToolInputJsonSchema(server, tool.name, tool.inputJsonSchema);
  declareToolOutputSchema(server, tool.name, tool.output);

  const callback = async (
    params: ToolArguments,
    extra: ToolExtra,
  ): Promise<CallToolResult> =>
    withErrorReporting(async () => {
      let stage: OperationStage = "input";
      let entity: string | undefined;
      let mutation = false;
      let enteredHandler = false;
      let operationName = tool.name;
      try {
        const action = actionOf(params);
        if (!action)
          throw new Error(
            `${tool.name} needs an \`action\`: one of ${actionNames.join(", ")}.`,
          );
        operationName = action.name;
        const execution = purchaseImportRunExecution
          .optional()
          .parse(params._runExecution);
        const input = action.input.parse(
          action.prepareInput(actionArguments(action, params)),
        );
        entity = action.telemetryEntity(input);
        stage = "context";
        mutation = action.kind === "mutation";
        const preparedExtra = await prepareToolExtra(
          extra,
          action.readPolicy(input),
        );
        enteredHandler = true;
        const trusted = trustedPurchaseAgent(preparedExtra);
        if (trusted)
          await assertPurchaseAgentAction(
            getEntityKernelContext(preparedExtra).db,
            trusted.runId,
            action.name,
            mutation,
          );
        const governed = selfGoverned(action);
        if (trusted && mutation && governed) {
          if (!execution)
            throw new Error(
              "Purchase-agent writes require the run execution envelope",
            );
          const [delegatedRun] = await getDb(
            getEntityKernelContext(preparedExtra).db,
          )
            .select({ id: runTable.id })
            .from(runTable)
            .where(eq(runTable.id, runEntityId.parse(trusted.runId)))
            .limit(1);
          if (delegatedRun?.id !== execution.runId)
            throw new Error(
              "Purchase-agent run execution does not match its delegation",
            );
        }
        stage = "run";
        const result =
          trusted && mutation && !governed
            ? await (async () => {
                const operationContext =
                  operationContextFromExtra(preparedExtra);
                if (!operationContext)
                  throw new Error(
                    "Purchase-agent operation context is missing",
                  );
                if (!execution)
                  throw new Error(
                    "Purchase-agent writes require the run execution envelope",
                  );
                const kernel = getEntityKernelContext(preparedExtra);
                return executePurchaseAgentMutation({
                  db: kernel.db,
                  actor: kernel.actorContext,
                  operationContext,
                  trusted,
                  toolName: action.name,
                  args: input,
                  execution,
                  run: (transactionExtra) =>
                    action.invoke(
                      input,
                      transactionExtra,
                      action.name,
                      execution,
                    ),
                  baseExtra: preparedExtra,
                });
              })()
            : await action.invoke(input, preparedExtra, action.name, execution);
        stage = "output";
        const response = structuredSuccess(result, action.output);
        if (mutation) runtime.markCalendarDirty(`mcp.${action.name}`);
        return response;
      } catch (error) {
        return structuredError(
          error,
          {
            operation: operationName,
            authenticated: extra.authInfo !== undefined,
            entity,
          },
          stage,
        );
      } finally {
        // A tool can commit before later validation or another item in a batch
        // fails. Advancing the shared window here keeps every client strong for
        // that possible partial write without turning a committed response into
        // an error when the Durable Object is unavailable.
        if (enteredHandler && mutation)
          await runtime.recordDatabaseWrite?.(`mcp.${operationName}`);
      }
    });

  const registeredInput = z.looseObject({ action: z.string() });
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: registeredInput,
      outputSchema: sdkOutputSchema(tool.output),
      annotations: tool.annotations,
      _meta: uiToolMeta(tool.name),
    },
    // SAFETY: the SDK's conditional ToolCallback type does not reduce for a
    // loose object. This callback accepts that argument bag, parses each
    // action's own schema, preserves ToolExtra, and returns a CallToolResult
    // in every branch.
    callback as ToolCallback<typeof registeredInput>,
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
