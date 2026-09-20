import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import type {
  PurchaseImportService,
  PurchaseImportServiceResult,
} from "./service";

const operationId = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const commandId = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const earliestAvailableOrderAt = v.pipe(
  v.string(),
  v.check(
    (value) => Number.isFinite(Date.parse(value)),
    "Expected an ISO timestamp",
  ),
);
const auditOffset = v.pipe(v.number(), v.integer(), v.minValue(0));
const serviceResult = v.nullable(v.looseObject({}));

export type PurchaseImportServiceResolver = () => PurchaseImportService;

function stepName(toolName: string, id: string): string {
  return `${toolName}:${id}`;
}

const pendingServiceResult = v.looseObject({
  status: v.optional(v.string()),
  state: v.optional(v.string()),
});

function pendingResult(result: PurchaseImportServiceResult): boolean {
  const parsed = v.safeParse(pendingServiceResult, result);
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
 * These are the entire model-facing authority surface. Keep browser commands
 * declarative and let the web service resolve account, vendor, ownership, and
 * domain constraints from the run instead of accepting them from the model.
 */
export function purchaseImportTools(
  runId: string,
  serviceForRun: PurchaseImportServiceResolver,
) {
  return [
    defineTool({
      name: "load_run_scope",
      description:
        "Read the owned account, vendor, limits, and current run state.",
      output: serviceResult,
      run: async () => ({
        output: await serviceForRun().loadRunScope({ runId }),
      }),
    }),
    defineTool({
      name: "claim_next_work",
      description: "Claim the next server-selected import work item.",
      input: v.object({ operationId }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(
          stepName("claim-next-work", data.operationId),
          () =>
            serviceForRun().claimNextWork({
              runId,
              operationId: data.operationId,
            }),
        ),
      }),
    }),
    defineTool({
      name: "issue_browser_command",
      description:
        "Request one fixed read-only browser action. The service validates the run's vendor domains and browser protocol generation.",
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
        const output = await step.do(
          stepName("issue-browser-command", data.operationId),
          () =>
            serviceForRun().issueBrowserCommand({
              runId,
              operationId: data.operationId,
              command: data.command,
            }),
        );
        return { output, terminate: pendingResult(output) };
      },
    }),
    defineTool({
      name: "read_browser_command_result",
      description:
        "Read the persisted result for the browser command issued by this operation. A pending result ends this submission; a browser_result queue event resumes this same agent.",
      input: v.object({ operationId }),
      output: serviceResult,
      run: async ({ data }) => {
        const output = await serviceForRun().readBrowserCommandResult({
          runId,
          operationId: data.operationId,
        });
        return { output, terminate: pendingResult(output) };
      },
    }),
    defineTool({
      name: "import_order_evidence",
      description:
        "Import evidence from one persisted browser command through Cubby's replay-safe purchase writer.",
      input: v.object({ operationId, commandId }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(
          stepName("import-order-evidence", data.operationId),
          () =>
            serviceForRun().importOrderEvidence({
              runId,
              operationId: data.operationId,
              commandId: data.commandId,
            }),
        ),
      }),
    }),
    defineTool({
      name: "save_navigation_hints",
      description:
        "Save observed navigational hints. The service accepts only URLs within the existing vendor domain allowlist.",
      input: v.object({
        operationId,
        hints: v.array(
          v.object({
            url: v.pipe(v.string(), v.url(), v.maxLength(2_048)),
            label: v.optional(v.pipe(v.string(), v.maxLength(256))),
          }),
        ),
      }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(
          stepName("save-navigation-hints", data.operationId),
          () =>
            serviceForRun().saveNavigationHints({
              runId,
              operationId: data.operationId,
              hints: data.hints,
            }),
        ),
      }),
    }),
    defineTool({
      name: "mark_history_expired",
      description: "Record the provider history limit for this run.",
      input: v.object({ operationId, earliestAvailableOrderAt }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(
          stepName("mark-history-expired", data.operationId),
          () =>
            serviceForRun().markHistoryExpired({
              runId,
              operationId: data.operationId,
              earliestAvailableOrderAt: data.earliestAvailableOrderAt,
            }),
        ),
      }),
    }),
    defineTool({
      name: "audit_batch",
      description:
        "Run the server-owned reasoning auditor for at most 25 imported orders.",
      input: v.object({ operationId, offset: auditOffset }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(stepName("audit-batch", data.operationId), () =>
          serviceForRun().auditBatch({
            runId,
            operationId: data.operationId,
            offset: data.offset,
          }),
        ),
      }),
    }),
    defineTool({
      name: "finish_run",
      description: "Finish a completed run after all claimed work has settled.",
      input: v.object({ operationId }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(stepName("finish-run", data.operationId), () =>
          serviceForRun().finishRun({ runId, operationId: data.operationId }),
        ),
        terminate: true,
      }),
    }),
    defineTool({
      name: "stop_for_review",
      description:
        "Create a run-scoped review finding for ambiguous evidence and terminate without speculative changes.",
      input: v.object({
        operationId,
        reason: v.picklist([
          "navigation_ambiguity",
          "unreadable_evidence",
          "provider_failure",
          "other",
        ]),
        detail: v.optional(v.pipe(v.string(), v.maxLength(1_000))),
      }),
      output: serviceResult,
      durable: true,
      run: async ({ data, step }) => ({
        output: await step.do(
          stepName("stop-for-review", data.operationId),
          () =>
            serviceForRun().stopForReview({
              runId,
              operationId: data.operationId,
              reason: data.reason,
              detail: data.detail,
            }),
        ),
        terminate: true,
      }),
    }),
  ] as const;
}

export function shouldSettleForBrowserResult(
  result: PurchaseImportServiceResult,
): boolean {
  return pendingResult(result);
}
