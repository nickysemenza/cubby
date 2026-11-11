import type { AgentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { MAIL_READ_RESPONSE_MAX_BYTES } from "@cubby/schemas/mailbox-research";
import { photoInventoryToolInputs } from "@cubby/schemas/purchase-agent-services";
import type { RunProgressStamp } from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineTool,
  type HookApi,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";

import type { RunServices } from "./environment";
import { claimImportTool } from "./mail-attempts";
import { CLAIM_IMPORT_WORK_TOOL } from "./tool-protocol";

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
  api: Pick<ToolExecutionApi, "memo">,
  context: Context,
  key: string,
  effect: () => Promise<object | null>,
): Promise<JsonValue> {
  const stored = await api.memo<{ value: JsonValue }>(key, context);
  if (stored) return stored.value;
  const value = z.json().parse(await effect());
  return (await api.memo(key, { value }, context)).value;
}

/** A final answer cannot strand an otherwise runnable Mail batch. */
export async function continueMailImportOnYield({
  services,
  api,
  context,
  generation,
}: {
  services: Pick<RunServices, "claimNextWork" | "loadScope">;
  api: HookApi;
  context: Context;
  generation: string | undefined;
}) {
  // A superseded final answer cannot restart the replacement coordinator.
  if (!generation || (await services.loadScope()).generation !== generation)
    return undefined;
  const work = await step(api, context, "mail-yield-work", async () =>
    services.claimNextWork({
      operationId: `yield:${await sha256Hex(String(api.taskId))}`,
    }),
  );
  const pending = z
    .object({
      kind: z.literal("email"),
      email: z.object({ mailboxId: z.string(), messageId: z.string() }),
    })
    .safeParse(work);
  if (!pending.success) return undefined;
  return {
    continue: `The Mail import batch still has unfinished work. Do not end the batch because one Email is blocked. Correct input validation using the tool's describe action. If this Email cannot be settled and escalation is unavailable, resolve this Email unresolved with the concrete reason, then claim the next Email. Stop only when no runnable Email remains or a blocker affects the entire Run. Call claim_next_import_work for its evidence. Current Email: ${JSON.stringify(pending.data.email)}`,
  };
}

/**
 * One Email's failure settles as that Email's `unresolved` outcome, which the
 * Run's review finding lists. Ending the Run would strand the rest of the batch
 * under a Run that keeps owning them. Only a provider failure blocks them all.
 */
const MAIL_STOP_REFUSAL =
  "This Run was not stopped. Resolve the current Email with purchase_import mail_resolve as unresolved, naming the blocker and any operation id whose outcome is unknown, then claim the next Email. Use reason provider_failure only when the same failure has now blocked two Emails in a row.";

async function mailBatchContinues(services: () => RunServices) {
  return (await services().loadScope()).purpose === "mail_import";
}

function result(
  output: JsonValue,
  terminate = false,
): ToolExecutionResult & {
  output: NonNullable<ToolExecutionResult["output"]>;
} {
  const content = [{ type: "text" as const, text: JSON.stringify(output) }];
  if (!terminate) return { output: content };
  return { output: content, control: { terminate: true } };
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
  return defineTool({
    name,
    // Non-strict, like the MCP tools in `cubby-mcp.ts`: pi-ai
    // `structuredClone`s strict tool parameters (see `ai/run-feature.ts`).
    // pi coerces loose scalars (`"TRUE"`, `"0"`) against plain JSON Schema.
    parameters: schema,
    // Every typed tool is replay-safe: its effects are memoized steps keyed
    // by the durable tool task.
    replay: "safe",
    // A complete mail read may be 200 KB. Pi's default 50 KB cap must not
    // silently cut its item lines while the claim still says complete.
    ...(name === CLAIM_IMPORT_WORK_TOOL
      ? {
          outputLimits: {
            maxBytes: MAIL_READ_RESPONSE_MAX_BYTES * 2,
            maxLines: 10_000,
          },
        }
      : {}),
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
 * Host-owned tools selected by the purpose's manifest. Mail claims publish
 * progress themselves; photo inventory retains model-directed progress.
 */
export function runAgentTools(
  services: () => RunServices,
  progressStamp: (
    api: ToolExecutionApi,
    context: Context,
  ) => Promise<RunProgressStamp>,
  purpose: AgentImportRunPurpose,
  report: <TError>(error: TError) => void,
  /** Move the current work item to the escalation model (`escalation.ts`). */
  escalate?: (
    request: z.infer<ToolInputs["escalate_import_work"]>,
  ) => Promise<object>,
): ToolRegistration[] {
  return [
    tool("escalate_import_work", {
      description:
        "Ask a stronger model one question about the current Email, only for extraction, identity, contradictions or an unclassified reasoning gap. It reads the Email and your facts and returns `answer`; you keep working this Email and make every write yourself. Each Email may ask twice (a second, stronger model answers the second). Missing evidence, member decisions, held sources and transient failures are refused. Returns answered: false with `unavailable` (the reason) when no question remains or none can be funded now: settle the Email yourself.",
      execute: async (args, api, context) => {
        if (!escalate) throw new Error("This Run has no escalation model");
        return result(
          await step(api, context, "escalate", () => escalate(args)),
        );
      },
    }),
    tool(CLAIM_IMPORT_WORK_TOOL, {
      description:
        "Claim and describe the run's next admitted work item (an Email for Mail import, with its compact read; a photo group for photo inventory). Call it again after resolving each item; continue until it returns done.",
      execute: async (_args, api, context) => {
        // New tool tasks observe current work; replay of this task keeps its result.
        const operationId = `claim:${await sha256Hex(String(api.taskId))}`;
        const output = await step(api, context, "claim-work", () =>
          services().claimNextWork({ operationId }),
        );
        if (purpose === "mail_import" && !claimStopped(output)) {
          const claimed = z
            .object({
              kind: z.literal("email"),
              email: z.object({ subject: z.string().nullable().optional() }),
            })
            .safeParse(output);
          const subject = claimed.success
            ? claimed.data.email.subject?.trim().slice(0, 500)
            : undefined;
          try {
            await step(api, context, "claim-progress", async () =>
              services().updateAgentProgress({
                ...(await progressStamp(api, context)),
                eventId: `${operationId}:progress`,
                phase: claimed.success ? "investigating" : "reconciling",
                ...(subject ? { currentItem: subject } : {}),
                detail: claimed.success
                  ? "Processing admitted Email evidence"
                  : "Checking Email import outcomes",
              }),
            );
          } catch (error) {
            // Observability must not turn a durable successful claim into a
            // tool error that asks the model to claim the Email again.
            report(error);
          }
        }
        // The run ended (for example an outdated Mac stopped it): nothing to claim.
        return result(
          purpose === "mail_import" &&
            z.object({ kind: z.literal("email") }).safeParse(output).success &&
            typeof output === "object" &&
            output !== null &&
            !Array.isArray(output)
            ? { ...output, importTool: claimImportTool(output) }
            : output,
          claimStopped(output),
        );
      },
    }),
    tool("report_agent_progress", {
      description:
        "Publish the current import phase for the live run UI. Set awaitingApproval when a Cubby tool requires a human decision; approval and review phases end this submission.",
      execute: async (args, api, context) => {
        await step(api, context, `agent-progress:${args.operationId}`, () =>
          (async () =>
            services().updateAgentProgress({
              ...(await progressStamp(api, context)),
              eventId: `agent-progress:${args.operationId}`,
              phase: args.phase,
              currentItem: args.currentItem,
              awaitingApproval: args.awaitingApproval,
              detail: args.detail,
            }))(),
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
      execute: async (args, api, context) => {
        if (
          args.reason !== "provider_failure" &&
          (await mailBatchContinues(services))
        )
          return result({ stopped: false, next: MAIL_STOP_REFUSAL });
        return result(
          await step(api, context, `stop-review:${args.operationId}`, () =>
            services().stopForReview(args),
          ),
          true,
        );
      },
    }),
  ];
}
