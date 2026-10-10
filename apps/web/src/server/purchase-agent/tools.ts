import { photoInventoryToolInputs } from "@cubby/schemas/purchase-agent-services";
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

const toolInputs = photoInventoryToolInputs;
type ToolInputs = typeof toolInputs;
type ToolName = keyof ToolInputs;

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
    execute: async (args, api, context) => {
      // pi-durable resumes execute checkpoints without revalidating their
      // saved arguments.
      const parsed = toolInputs[name].parse(args);
      return definition.execute(
        // SAFETY: the indexed tool's own parsed input.
        parsed as z.input<ToolInputs[N]>,
        api,
        context,
      );
    },
  });
}

/**
 * The host-owned tools every import Run's agent mounts beside its Cubby MCP
 * actions: claim the next admitted item, publish progress, stop for review.
 */
export function runAgentTools(services: () => RunServices): ToolRegistration[] {
  return [
    tool("claim_next_import_work", {
      description:
        "Claim and describe the run's next admitted work item (an Email for Mail import, a photo group for photo inventory). Call it again after resolving each item; continue until it returns done.",
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
