import {
  photoInventoryToolInputs,
  purchaseAgentToolInputs,
} from "@cubby/schemas/purchase-agent-services";
import { researchAttachmentOriginal } from "@cubby/schemas/research-tools";
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";

import type { RunServices } from "./environment";

const toolInputs = { ...purchaseAgentToolInputs, ...photoInventoryToolInputs };
type ToolInputs = typeof toolInputs;
type ToolName = keyof ToolInputs;

/** The lifecycle fields of a browser command result. */
const browserCommandState = z.looseObject({
  status: z.string().optional(),
  state: z.string().optional(),
});

const claimStopped = (output: JsonValue) =>
  z.object({ kind: z.literal("stopped") }).safeParse(output).success;

/**
 * One service effect per step key. The first completion is memoized on the tool
 * task, so a call replayed after an eviction returns the stored result instead
 * of repeating the effect; the server is idempotent by operation id as well.
 */
async function step(
  api: ToolExecutionApi,
  context: Context,
  key: string,
  effect: () => Promise<object | null>,
): Promise<JsonValue> {
  const stored = await api.memo<{ value: JsonValue }>(key, context);
  if (stored) return stored.value;
  const value = z.json().parse(await effect());
  return (await api.memo(key, { value }, context)).value;
}

function result(
  output: JsonValue,
  terminate = false,
): ToolExecutionResult & {
  content: NonNullable<ToolExecutionResult["content"]>;
} {
  const content = [{ type: "text" as const, text: JSON.stringify(output) }];
  if (!terminate) return { content };
  return { content, control: { terminate: true } };
}

function originalMediaResult(
  output: JsonValue,
  terminate: boolean,
): ToolExecutionResult {
  const parsed = z
    .looseObject({ originalAttachment: researchAttachmentOriginal.optional() })
    .parse(output);
  if (!parsed.originalAttachment) return result(output, terminate);
  const { dataBase64, ...descriptor } = parsed.originalAttachment;
  const text = result(
    z.json().parse({ ...parsed, originalAttachment: descriptor }),
    terminate,
  );
  return {
    ...text,
    content: [
      ...text.content,
      { type: "image", data: dataBase64, mimeType: descriptor.mimeType },
    ],
  };
}

type JsonSchema = z.core.JSONSchema._JSONSchema;

/**
 * A contract's JSON Schema rebuilt from TypeBox builders, every other keyword
 * kept as is. pi converts a call's arguments with TypeBox `Value.Convert`
 * before validating, and that sees only TypeBox-built nodes: behind
 * `Type.Unsafe` pi's narrower coercion refused a model's `"TRUE"` or `"0"`
 * for a boolean. A shape this does not know fails when the tools are built.
 */
function typeboxSchema(node: JsonSchema): TSchema {
  if (node === true || node === false)
    throw new Error("Unsupported boolean schema");
  if (node.$ref) return Type.Unsafe(node);
  const { type, properties, required, items, anyOf, oneOf, ...options } = node;
  const alternatives = anyOf ?? oneOf;
  if (alternatives) return Type.Union(alternatives.map(typeboxSchema), options);
  if (Array.isArray(type))
    return Type.Union(
      type.map((variant) => typeboxSchema({ ...node, type: variant })),
      options,
    );
  if (node.const !== undefined)
    return Type.Literal(
      z.union([z.string(), z.number(), z.boolean()]).parse(node.const),
      options,
    );
  switch (type) {
    case "object":
      return Type.Object(
        Object.fromEntries(
          Object.entries(properties ?? {}).map(([key, value]) => {
            const property = typeboxSchema(value);
            return [
              key,
              required?.includes(key) ? property : Type.Optional(property),
            ];
          }),
        ),
        options,
      );
    case "array":
      if (items === undefined || Array.isArray(items))
        throw new Error("Unsupported array schema");
      return Type.Array(typeboxSchema(items), options);
    case "null":
      return Type.Null(options);
    case "string":
      return Type.String(options);
    case "boolean":
      return Type.Boolean(options);
    case "number":
    case "integer":
      return numericSchema(type, options);

    default:
      return Type.Unsafe(node);
  }
}

function numericSchema(
  type: "number" | "integer",
  options: Exclude<JsonSchema, boolean>,
): TSchema {
  const { exclusiveMinimum: min, exclusiveMaximum: max, ...rest } = options;
  const bounds = {
    ...rest,
    ...(min !== undefined && { exclusiveMinimum: z.number().parse(min) }),
    ...(max !== undefined && { exclusiveMaximum: z.number().parse(max) }),
  };
  return type === "number" ? Type.Number(bounds) : Type.Integer(bounds);
}

/**
 * One typed tool: its contract's JSON Schema is what the model sees and what
 * pi validates the call against before `execute`.
 */
function tool<N extends ToolName>(
  name: N,
  definition: {
    description: string;
    execute: (
      args: z.input<ToolInputs[N]>,
      api: ToolExecutionApi,
      context: Context,
    ) => Promise<ToolExecutionResult>;
  },
) {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(toolInputs[name], {
    target: "draft-7",
    io: "input",
  });
  return defineTool<TSchema>({
    name,
    // Non-strict, like the MCP tools in `cubby-mcp.ts`: pi-ai
    // `structuredClone`s strict tool parameters (see `ai/run-feature.ts`).
    parameters: typeboxSchema(schema),
    // Every typed tool is replay-safe: its effects are memoized steps keyed
    // by the durable tool task.
    replay: "safe",
    ...definition,
    execute: (args, api, context) =>
      definition.execute(
        // SAFETY: the same indexed schema parses this tool's input, including defaults.
        toolInputs[name].parse(args) as z.input<ToolInputs[N]>,
        api,
        context,
      ),
  });
}

/**
 * Typed run services are deliberately limited to seams that cannot travel
 * through MCP: browser commands must end the run while the user's browser
 * works, progress must be visible before another model turn completes, and
 * lifecycle transitions stay behind the host's crash-safe guards.
 *
 * A terminating tool ends the run only when it is the round's sole call; the
 * agent's transport disables parallel tool calls so that always holds.
 */
export function purchaseImportTools(
  services: () => RunServices,
  retainOutput?: (output: JsonValue) => Promise<void>,
  beforeEffect?: () => Promise<void>,
): ToolRegistration[] {
  const run = <N extends keyof typeof purchaseAgentToolInputs>(
    name: N,
    description: string,
    effect: (
      service: RunServices,
      args: z.input<(typeof purchaseAgentToolInputs)[N]>,
      callId: string,
    ) => Promise<object>,
  ) =>
    tool(name, {
      description,
      execute: async (args, api, context) => {
        await beforeEffect?.();
        const stored = await api.memo<{ value: string }>(
          "host-call-id",
          context,
        );
        const callId =
          stored?.value ??
          (
            await api.memo(
              "host-call-id",
              { value: crypto.randomUUID() },
              context,
            )
          ).value;
        const output = await step(api, context, "service-result", () =>
          effect(services(), args, callId),
        );
        await retainOutput?.(output);
        return originalMediaResult(output, researchTerminated(output));
      },
    });
  return [
    run(
      "work_next",
      "Get the next bounded research task. No remaining work automatically settles the Run.",
      (service, args, callId) => service.researchNext(args, callId),
    ),
    run(
      "work_observe",
      "Read the selected receipt original, or observe and interact with the assigned browser source using retained observation references. browser_pending retains the offline command: investigate public or mail sources for this task, or request another task with work_next. waiting ends this turn.",
      (service, args, callId) => service.researchObserve(args, callId),
    ),
    run(
      "work_resolve",
      "Resolve the assigned research task with semantic identity reasoning, evidence-backed facts and retained candidates. The host validates safe writes and returns next work or done.",
      (service, args, callId) => service.researchResolve(args, callId),
    ),
    run(
      "mail_search",
      "Search connected Gmail for any assigned task. Select an issued mailboxRef if several are available. Continue the same query with the issued continuationRef until exhausted. Related discoveries enter child mail research; returned message references provide context and do not grant this task write ownership. A Gmail reconnect result leaves other research available; use a new call after reconnecting.",
      (service, args, callId) => service.researchMailSearch(args, callId),
    ),
    run(
      "mail_read",
      "Read an authorized message and list its attachment references. Supply an attachmentRef from that result to inspect its full original PDF/image (up to 3 MiB) as retained evidence for this task.",
      (service, args, callId) => service.researchMailRead(args, callId),
    ),
    run(
      "web_search",
      "Search public web sources for the assigned task.",
      (service, args, callId) => service.researchWebSearch(args, callId),
    ),
    run(
      "web_read",
      "Read a public web source and retain its observation as evidence for this task.",
      (service, args, callId) => service.researchWebRead(args, callId),
    ),
    run(
      "cubby_find",
      "Find existing Cubby context relevant to this task.",
      (service, args, callId) => service.researchFind(args, callId),
    ),
  ];
}

function researchTerminated(output: JsonValue): boolean {
  const parsed = browserCommandState.safeParse(output);
  return (
    claimStopped(output) ||
    (parsed.success &&
      [parsed.data.state, parsed.data.status].some(
        (state) =>
          state === "waiting" ||
          state === "done" ||
          state === "stopped" ||
          state === "paused_auth",
      ))
  );
}

/** Photo inventory keeps its restricted existing tools and replay keys. */
export function photoInventoryTools(
  services: () => RunServices,
): ToolRegistration[] {
  return [
    tool("claim_next_import_work", {
      description:
        "Claim and describe the run's next bounded work item. Use this before choosing saved mail, receipt or browser evidence work, and again after each committed item. For settlement_verification, verify the named existing Purchase against saved statement evidence, then finish or stop for review rather than claiming this item repeatedly. Otherwise continue until none.",
      execute: async (args, api, context) => {
        const output = await step(
          api,
          context,
          `claim-work:${args.operationId}`,
          () => services().claimNextWork(args),
        );
        // The run ended (for example an outdated Mac stopped it): nothing to claim.
        return result(output, claimStopped(output));
      },
    }),
    tool("report_agent_progress", {
      description:
        "Publish the current import phase for the live run UI. Set awaitingApproval when a Cubby tool requires a human decision; approval and review phases end this submission.",
      execute: async (args, api, context) => {
        await step(api, context, `agent-progress:${args.operationId}`, () =>
          services().updateAgentProgress({
            eventId: `agent-progress:${args.operationId}`,
            phase: args.phase,
            currentItem: args.currentItem,
            awaitingApproval: args.awaitingApproval,
            detail: args.detail,
          }),
        );
        // A `review` report ends the run's submission, so it must also move
        // the run: a progress row alone left runs `running` with no
        // coordinator behind them.
        if (args.phase === "review")
          await step(
            api,
            context,
            `agent-progress-review:${args.operationId}`,
            () =>
              services().stopForReview({
                operationId: `agent-progress-review:${args.operationId}`,
                reason: "other",
                detail: args.detail,
              }),
          );
        return result(
          { recorded: true, phase: args.phase },
          args.phase === "awaiting_approval" || args.phase === "review",
        );
      },
    }),
    tool("stop_import_run_for_review", {
      description:
        "Stop on ambiguous or unreadable evidence without speculative writes. The server creates one run-scoped finding, runs required audits, fences the run, and records needs_review.",
      execute: async (args, api, context) =>
        result(
          await step(api, context, `stop-review:${args.operationId}`, () =>
            services().stopForReview(args),
          ),
          true,
        ),
    }),
  ];
}
