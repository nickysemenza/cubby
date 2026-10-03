import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { tradeValues } from "@cubby/schemas/task-fields";

import type {
  PurchaseImportService,
  PurchaseImportServiceResult,
} from "./service";

const operationId = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const serviceResult = v.nullable(v.looseObject({}));
const progressPhase = v.picklist([
  "preparing",
  "investigating",
  "awaiting_browser",
  "awaiting_approval",
  "committing",
  "review",
  "complete",
]);
const boundedUrl = v.pipe(v.string(), v.url(), v.maxLength(2_048));

export type PurchaseImportServiceResolver = () => PurchaseImportService;

function pendingResult(result: PurchaseImportServiceResult): boolean {
  const parsed = v.safeParse(
    v.looseObject({
      status: v.optional(v.string()),
      state: v.optional(v.string()),
    }),
    result,
  );
  return (
    parsed.success &&
    (parsed.output.status === "pending" ||
      parsed.output.state === "pending" ||
      parsed.output.state === "dispatched" ||
      parsed.output.state === "paused_auth" ||
      parsed.output.state === "paused_offline")
  );
}

/**
 * Typed RPC is deliberately limited to seams that cannot travel through MCP:
 * browser commands must settle the Flue submission while the user's browser
 * works, progress must be visible before another model turn completes, and
 * lifecycle transitions stay behind the web Worker's crash-safe guards.
 */
export function purchaseImportTools(
  runId: string,
  serviceForRun: PurchaseImportServiceResolver,
  onTerminate: () => void = () => {},
) {
  const settle = <T>(result: { output: T; terminate: boolean }) => {
    if (result.terminate) onTerminate();
    return result;
  };
  return [
    defineTool({
      name: "claim_next_import_work",
      description:
        "Claim and describe the run's next bounded work item. Use this before choosing saved mail, receipt or browser evidence work, and again after each committed item. For settlement_verification, verify the named existing Purchase against saved statement evidence, then finish or stop for review rather than claiming this item repeatedly. Otherwise continue until none.",
      input: v.object({ operationId }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(`claim-work:${data.operationId}`, () =>
          serviceForRun().claimNextWork({ runId, ...data }),
        ),
      }),
    }),
    defineTool({
      name: "extract_receipt_evidence",
      description:
        "Run Cubby's bounded receipt extractor for the receipt assigned to this run. Its returned immutable source, checksum, extraction, image id, and stable ids are the input to purchase_import.prepare.",
      input: v.object({ operationId }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(`extract-receipt:${data.operationId}`, () =>
          serviceForRun().extractReceiptEvidence({ runId, ...data }),
        ),
      }),
    }),
    defineTool({
      name: "extract_run_evidence",
      description:
        "Extract the saved confirmation assigned to mail_evidence work, or immutable uploaded evidence for a purchase validation target. Pass the returned source, checksum, extraction, revision and stable ids unchanged to purchase_import.prepare. Use this instead of a shared Image or document API.",
      input: v.object({ operationId }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(`extract-run-evidence:${data.operationId}`, () =>
          serviceForRun().extractRunEvidence({ runId, ...data }),
        ),
      }),
    }),
    defineTool({
      name: "issue_browser_command",
      description:
        "Request one fixed read-only browser action. A pending command ends this submission; a queue event resumes this same agent when evidence is ready.",
      input: v.object({
        operationId,
        command: v.object({
          kind: v.picklist([
            "navigate_orders",
            "capture_order",
            "capture_pdf",
            "capture_screenshot",
          ]),
          target: v.optional(v.pipe(v.string(), v.maxLength(2_048))),
        }),
      }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => {
        await step.do(`browser-progress:${data.operationId}`, () =>
          serviceForRun().updateAgentProgress({
            runId,
            eventId: `browser-progress:${data.operationId}`,
            phase: "awaiting_browser",
            currentItem: data.command.target,
            detail: data.command.kind,
          }),
        );
        const output = await step.do(
          `browser-command:${data.operationId}`,
          () =>
            serviceForRun().issueBrowserCommand({
              runId,
              operationId: `browser-command:${data.operationId}`,
              command: data.command,
            }),
        );
        return settle({ output, terminate: pendingResult(output) });
      },
    }),
    defineTool({
      name: "read_browser_command_result",
      description:
        "Read the persisted result for a browser command. A pending result ends this submission; do not poll it.",
      input: v.object({ operationId }),
      output: serviceResult,
      run: async ({ data }) => {
        const output = await serviceForRun().readBrowserCommandResult({
          runId,
          operationId: `browser-command:${data.operationId}`,
        });
        return settle({ output, terminate: pendingResult(output) });
      },
    }),
    defineTool({
      name: "import_browser_order_evidence",
      description:
        "Bind a completed browser command's retained evidence to its exact run target before preparation or enrichment. Use the commandId returned by the browser result. For an order page, pass defaultTrade (and defaultProjectId when known) exactly as for purchase_import.commit: a principal line without a trade from its Purchase or Project is refused.",
      input: v.object({
        operationId,
        commandId: v.pipe(v.string(), v.uuid()),
        defaultTrade: v.optional(v.picklist(tradeValues)),
        defaultProjectId: v.optional(v.pipe(v.string(), v.minLength(1))),
      }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(
          `import-browser-evidence:${data.operationId}`,
          () => serviceForRun().importOrderEvidence({ runId, ...data }),
        ),
      }),
    }),
    defineTool({
      name: "report_agent_progress",
      description:
        "Publish the current import phase for the live run UI. Set awaitingApproval when a Cubby tool requires a human decision; approval and review phases end this submission.",
      input: v.object({
        operationId,
        phase: progressPhase,
        currentItem: v.optional(v.pipe(v.string(), v.maxLength(500))),
        awaitingApproval: v.optional(v.boolean()),
        detail: v.optional(v.pipe(v.string(), v.maxLength(1_000))),
      }),
      durable: true,
      run: async ({ data, step }) => {
        await step.do(`agent-progress:${data.operationId}`, () =>
          serviceForRun().updateAgentProgress({
            runId,
            eventId: `agent-progress:${data.operationId}`,
            phase: data.phase,
            currentItem: data.currentItem,
            awaitingApproval: data.awaitingApproval,
            detail: data.detail,
          }),
        );
        // A `review` report ends the submission, so it must also move the run:
        // a progress row alone left runs `running` with no coordinator behind
        // them. The same server transition `stop_import_run_for_review` takes.
        if (data.phase === "review") {
          await step.do(`agent-progress-review:${data.operationId}`, () =>
            serviceForRun().stopForReview({
              runId,
              operationId: `agent-progress-review:${data.operationId}`,
              reason: "other",
              detail: data.detail,
            }),
          );
        }
        return settle({
          output: { recorded: true, phase: data.phase },
          terminate:
            data.phase === "awaiting_approval" || data.phase === "review",
        });
      },
    }),
    defineTool({
      name: "save_navigation_hints",
      description:
        "Persist observed vendor navigation hints. The server accepts only URLs inside the vendor's existing browser allowlist; this tool cannot expand browser authority.",
      input: v.object({
        operationId,
        hints: v.pipe(
          v.array(
            v.object({
              url: boundedUrl,
              label: v.optional(v.pipe(v.string(), v.maxLength(500))),
            }),
          ),
          v.minLength(1),
          v.maxLength(25),
        ),
      }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(`navigation-hints:${data.operationId}`, () =>
          serviceForRun().saveNavigationHints({ runId, ...data }),
        ),
      }),
    }),
    defineTool({
      name: "mark_history_expired",
      description:
        "Record the earliest order timestamp the vendor still exposes after the bounded history scan proves older orders are unavailable.",
      input: v.object({
        operationId,
        earliestAvailableOrderAt: v.pipe(v.string(), v.isoTimestamp()),
      }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(`history-expired:${data.operationId}`, () =>
          serviceForRun().markHistoryExpired({ runId, ...data }),
        ),
      }),
    }),
    defineTool({
      name: "finish_import_run",
      description:
        "Complete the run only after every selected order or hunt is resolved or explicitly exhausted. The server refuses pending hunts and enforces all required audit batches before completion.",
      input: v.object({ operationId }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) =>
        settle({
          output: await step.do(`finish-run:${data.operationId}`, () =>
            serviceForRun().finishRun({ runId, ...data }),
          ),
          terminate: true,
        }),
    }),
    defineTool({
      name: "stop_import_run_for_review",
      description:
        "Stop on ambiguous or unreadable evidence without speculative writes. The server creates one run-scoped finding, runs required audits, fences the run, and records needs_review.",
      input: v.object({
        operationId,
        reason: v.picklist([
          "navigation_ambiguity",
          "unreadable_evidence",
          "provider_failure",
          "other",
        ]),
        detail: v.optional(
          v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
        ),
      }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) =>
        settle({
          output: await step.do(`stop-review:${data.operationId}`, () =>
            serviceForRun().stopForReview({ runId, ...data }),
          ),
          terminate: true,
        }),
    }),
    defineTool({
      name: "defer_order_for_review",
      description:
        "Leave one listed order from this account-sync worklist for human review when its evidence stays ambiguous or unreadable, then continue with the remaining orders. The server records one finding naming the order and marks it skipped; the run then ends in review instead of claiming a complete import.",
      input: v.object({
        operationId,
        orderId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        detail: v.pipe(v.string(), v.minLength(1), v.maxLength(1_000)),
      }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(`defer-order:${data.operationId}`, () =>
          serviceForRun().deferOrderForReview({ runId, ...data }),
        ),
      }),
    }),
  ] as const;
}

export function shouldSettleForBrowserResult(
  result: PurchaseImportServiceResult,
): boolean {
  return pendingResult(result);
}
