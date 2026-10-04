import { tradeValues } from "@cubby/schemas/task-fields";
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";

import type { PurchaseImportService } from "./service";

const operationId = Type.String({ minLength: 1, maxLength: 200 });
const boundedUrl = Type.String({ format: "uri", maxLength: 2_048 });
const picklist = <const T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value)));

export type PurchaseImportServiceResolver = () => PurchaseImportService;

/** The lifecycle fields of a browser command result. */
const browserCommandState = z.looseObject({
  status: z.string().optional(),
  state: z.string().optional(),
});

function pendingResult(result: JsonValue): boolean {
  const parsed = browserCommandState.safeParse(result);
  return (
    parsed.success &&
    (parsed.data.status === "pending" ||
      parsed.data.state === "pending" ||
      parsed.data.state === "dispatched" ||
      parsed.data.state === "paused_auth" ||
      parsed.data.state === "paused_offline")
  );
}

/**
 * One RPC effect per step key. The first completion is memoized on the tool
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

function result(output: JsonValue, terminate = false): ToolExecutionResult {
  const content = [{ type: "text" as const, text: JSON.stringify(output) }];
  if (!terminate) return { content };
  return { content, control: { terminate: true } };
}

const tool = <P extends TSchema>(definition: ToolRegistration<P>) =>
  // Every typed tool is replay-safe: its effects are memoized steps keyed by
  // the model's operation id.
  defineTool({ replay: "safe", ...definition });

/**
 * Typed RPC is deliberately limited to seams that cannot travel through MCP:
 * browser commands must end the run while the user's browser works, progress
 * must be visible before another model turn completes, and lifecycle
 * transitions stay behind the web Worker's crash-safe guards.
 *
 * A terminating tool ends the run only when it is the round's sole call; the
 * agent's transport disables parallel tool calls so that always holds.
 */
export function purchaseImportTools(
  runId: string,
  serviceForRun: PurchaseImportServiceResolver,
): ToolRegistration[] {
  const op = Type.Object({ operationId });
  return [
    tool({
      name: "claim_next_import_work",
      description:
        "Claim and describe the run's next bounded work item. Use this before choosing saved mail, receipt or browser evidence work, and again after each committed item. For settlement_verification, verify the named existing Purchase against saved statement evidence, then finish or stop for review rather than claiming this item repeatedly. Otherwise continue until none.",
      parameters: op,
      execute: async (args, api, context) =>
        result(
          await step(api, context, `claim-work:${args.operationId}`, () =>
            serviceForRun().claimNextWork({ runId, ...args }),
          ),
        ),
    }),
    tool({
      name: "extract_receipt_evidence",
      description:
        "Run Cubby's bounded receipt extractor for the receipt assigned to this run. Its returned immutable source, checksum, extraction, image id, and stable ids are the input to purchase_import.prepare.",
      parameters: op,
      execute: async (args, api, context) =>
        result(
          await step(api, context, `extract-receipt:${args.operationId}`, () =>
            serviceForRun().extractReceiptEvidence({ runId, ...args }),
          ),
        ),
    }),
    tool({
      name: "extract_run_evidence",
      description:
        "Extract the saved confirmation assigned to mail_evidence work, or immutable uploaded evidence for a purchase validation target. Pass the returned source, checksum, extraction, revision and stable ids unchanged to purchase_import.prepare. Use this instead of a shared Image or document API.",
      parameters: op,
      execute: async (args, api, context) =>
        result(
          await step(
            api,
            context,
            `extract-run-evidence:${args.operationId}`,
            () => serviceForRun().extractRunEvidence({ runId, ...args }),
          ),
        ),
    }),
    tool({
      name: "issue_browser_command",
      description:
        "Request one fixed read-only browser action. A pending command ends this submission; a queue event resumes this same agent when evidence is ready.",
      parameters: Type.Object({
        operationId,
        command: Type.Object({
          kind: picklist([
            "navigate_orders",
            "capture_order",
            "capture_pdf",
            "capture_screenshot",
          ]),
          target: Type.Optional(Type.String({ maxLength: 2_048 })),
        }),
      }),
      execute: async (args, api, context) => {
        await step(api, context, `browser-progress:${args.operationId}`, () =>
          serviceForRun().updateAgentProgress({
            runId,
            eventId: `browser-progress:${args.operationId}`,
            phase: "awaiting_browser",
            currentItem: args.command.target,
            detail: args.command.kind,
          }),
        );
        const output = await step(
          api,
          context,
          `browser-command:${args.operationId}`,
          () =>
            serviceForRun().issueBrowserCommand({
              runId,
              operationId: `browser-command:${args.operationId}`,
              command: args.command,
            }),
        );
        return result(output, pendingResult(output));
      },
    }),
    tool({
      name: "read_browser_command_result",
      description:
        "Read the persisted result for a browser command. A pending result ends this submission; do not poll it.",
      parameters: op,
      execute: async (args) => {
        const output = z.json().parse(
          (await serviceForRun().readBrowserCommandResult({
            runId,
            operationId: `browser-command:${args.operationId}`,
          })) ?? null,
        );
        return result(output, pendingResult(output));
      },
    }),
    tool({
      name: "import_browser_order_evidence",
      description:
        "Bind a completed browser command's retained evidence to its exact run target before preparation or enrichment. Use the commandId returned by the browser result. For an order page, pass defaultTrade (and defaultProjectId when known) exactly as for purchase_import.commit: a principal line without a trade from its Purchase or Project is refused.",
      parameters: Type.Object({
        operationId,
        commandId: Type.String({ format: "uuid" }),
        defaultTrade: Type.Optional(picklist(tradeValues)),
        defaultProjectId: Type.Optional(Type.String({ minLength: 1 })),
      }),
      execute: async (args, api, context) =>
        result(
          await step(
            api,
            context,
            `import-browser-evidence:${args.operationId}`,
            () => serviceForRun().importOrderEvidence({ runId, ...args }),
          ),
        ),
    }),
    tool({
      name: "report_agent_progress",
      description:
        "Publish the current import phase for the live run UI. Set awaitingApproval when a Cubby tool requires a human decision; approval and review phases end this submission.",
      parameters: Type.Object({
        operationId,
        phase: picklist([
          "preparing",
          "investigating",
          "awaiting_browser",
          "awaiting_approval",
          "committing",
          "review",
          "complete",
        ]),
        currentItem: Type.Optional(Type.String({ maxLength: 500 })),
        awaitingApproval: Type.Optional(Type.Boolean()),
        detail: Type.Optional(Type.String({ maxLength: 1_000 })),
      }),
      execute: async (args, api, context) => {
        await step(api, context, `agent-progress:${args.operationId}`, () =>
          serviceForRun().updateAgentProgress({
            runId,
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
              serviceForRun().stopForReview({
                runId,
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
    tool({
      name: "save_navigation_hints",
      description:
        "Persist observed vendor navigation hints. The server accepts only URLs inside the vendor's existing browser allowlist; this tool cannot expand browser authority.",
      parameters: Type.Object({
        operationId,
        hints: Type.Array(
          Type.Object({
            url: boundedUrl,
            label: Type.Optional(Type.String({ maxLength: 500 })),
          }),
          { minItems: 1, maxItems: 25 },
        ),
      }),
      execute: async (args, api, context) =>
        result(
          await step(api, context, `navigation-hints:${args.operationId}`, () =>
            serviceForRun().saveNavigationHints({ runId, ...args }),
          ),
        ),
    }),
    tool({
      name: "mark_history_expired",
      description:
        "Record the earliest order timestamp the vendor still exposes after the bounded history scan proves older orders are unavailable.",
      parameters: Type.Object({
        operationId,
        earliestAvailableOrderAt: Type.String({ format: "date-time" }),
      }),
      execute: async (args, api, context) =>
        result(
          await step(api, context, `history-expired:${args.operationId}`, () =>
            serviceForRun().markHistoryExpired({ runId, ...args }),
          ),
        ),
    }),
    tool({
      name: "finish_import_run",
      description:
        "Complete the run only after every selected order or hunt is resolved or explicitly exhausted. The server refuses pending hunts and enforces all required audit batches before completion.",
      parameters: op,
      execute: async (args, api, context) =>
        result(
          await step(api, context, `finish-run:${args.operationId}`, () =>
            serviceForRun().finishRun({ runId, ...args }),
          ),
          true,
        ),
    }),
    tool({
      name: "stop_import_run_for_review",
      description:
        "Stop on ambiguous or unreadable evidence without speculative writes. The server creates one run-scoped finding, runs required audits, fences the run, and records needs_review.",
      parameters: Type.Object({
        operationId,
        reason: picklist([
          "navigation_ambiguity",
          "unreadable_evidence",
          "provider_failure",
          "other",
        ]),
        detail: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
      }),
      execute: async (args, api, context) =>
        result(
          await step(api, context, `stop-review:${args.operationId}`, () =>
            serviceForRun().stopForReview({ runId, ...args }),
          ),
          true,
        ),
    }),
    tool({
      name: "defer_order_for_review",
      description:
        "Leave one listed order from this account-sync worklist for human review when its evidence stays ambiguous or unreadable, then continue with the remaining orders. The server records one finding naming the order and marks it skipped; the run then ends in review instead of claiming a complete import.",
      parameters: Type.Object({
        operationId,
        orderId: Type.String({ minLength: 1, maxLength: 200 }),
        detail: Type.String({ minLength: 1, maxLength: 1_000 }),
      }),
      execute: async (args, api, context) =>
        result(
          await step(api, context, `defer-order:${args.operationId}`, () =>
            serviceForRun().deferOrderForReview({ runId, ...args }),
          ),
        ),
    }),
    tool({
      name: "settle_charge_hunt",
      description:
        "Record the outcome of one statement charge this run was asked to find, when importing evidence did not settle it. Use not_found after searching the vendor account for the charge's amount and date window without a matching order; use needs_review when a candidate order exists but stays ambiguous or unreadable. The server records the outcome for that one charge and the run continues with the remaining charges; it then ends in review instead of claiming a complete import. A charge the server already settled is recorded as resolved.",
      parameters: Type.Object({
        operationId,
        huntId: Type.String({ format: "uuid" }),
        outcome: picklist(["not_found", "needs_review"]),
        detail: Type.String({ minLength: 1, maxLength: 1_000 }),
      }),
      execute: async (args, api, context) =>
        result(
          await step(
            api,
            context,
            `settle-charge-hunt:${args.operationId}`,
            () => serviceForRun().settleChargeHunt({ runId, ...args }),
          ),
        ),
    }),
  ];
}
