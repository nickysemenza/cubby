/**
 * The web Worker's named WorkerEntrypoint is the only authority over Cubby's
 * database, documents, browser broker, and member ownership. This Worker has
 * no database or browser bindings by design.
 */
import type { CloudflareContext } from "@flue/runtime/cloudflare";
import { z } from "zod";

const purchaseImportServiceResult = z
  .record(z.string(), z.unknown())
  .nullable();
export type PurchaseImportServiceResult = z.infer<
  typeof purchaseImportServiceResult
>;

export interface PurchaseImportService {
  loadRunScope(input: { runId: string }): Promise<PurchaseImportServiceResult>;
  claimNextWork(input: {
    runId: string;
    operationId: string;
  }): Promise<PurchaseImportServiceResult>;
  issueBrowserCommand(input: {
    runId: string;
    operationId: string;
    command: {
      kind:
        | "navigate_orders"
        | "capture_order"
        | "capture_pdf"
        | "capture_screenshot";
      target?: string;
    };
  }): Promise<PurchaseImportServiceResult>;
  readBrowserCommandResult(input: {
    runId: string;
    operationId: string;
  }): Promise<PurchaseImportServiceResult>;
  importOrderEvidence(input: {
    runId: string;
    operationId: string;
    commandId: string;
  }): Promise<PurchaseImportServiceResult>;
  saveNavigationHints(input: {
    runId: string;
    operationId: string;
    hints: Array<{ url: string; label?: string }>;
  }): Promise<PurchaseImportServiceResult>;
  markHistoryExpired(input: {
    runId: string;
    operationId: string;
    earliestAvailableOrderAt: string;
  }): Promise<PurchaseImportServiceResult>;
  auditBatch(input: {
    runId: string;
    operationId: string;
    offset: number;
  }): Promise<PurchaseImportServiceResult>;
  finishRun(input: {
    runId: string;
    operationId: string;
  }): Promise<PurchaseImportServiceResult>;
  stopForReview(input: {
    runId: string;
    operationId: string;
    reason:
      | "navigation_ambiguity"
      | "unreadable_evidence"
      | "provider_failure"
      | "other";
    detail?: string;
  }): Promise<PurchaseImportServiceResult>;
  recordOrchestrationUsage(input: {
    runId: string;
    operationId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCost: number;
  }): Promise<PurchaseImportServiceResult>;
  markRunFailed(input: {
    runId: string;
    operationId: string;
    failureCode: "flue_failed" | "flue_aborted";
    detail?: string;
  }): Promise<PurchaseImportServiceResult>;
}

const serviceBindingSchema = z.object({
  CUBBY_PURCHASE_SERVICE: z.custom<PurchaseImportService>(),
});

export function purchaseImportService(
  env: CloudflareContext["env"],
): PurchaseImportService {
  return serviceBindingSchema.parse(env).CUBBY_PURCHASE_SERVICE;
}
