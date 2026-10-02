// Types only, importing nothing but schema types: the global
// worker-configuration.d.ts reaches this file through worker-bindings.ts, and
// tsc re-checks the whole program after an edit to anything it reaches
// (docs/local-check-performance.md#typechecking).
import type {
  BrowserBridgeRequest,
  BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";

export interface PurchaseImportDurableObjectRpc {
  enqueue(command: BrowserBridgeRequest): Promise<void>;
  result(requestId: string): Promise<BrowserBridgeResult | null>;
  cancel(requestId: string): Promise<void>;
  connected(): Promise<boolean>;
  /** Commands for this run still queued or in flight on the bridge, oldest first. */
  pendingCommands(
    runID: string,
  ): Promise<Array<{ requestId: string; createdAt: number }>>;
  notifyRunCompleted(summary: {
    runID: string;
    terminalStatus: "completed" | "needs_review" | "failed" | "dispatch_failed";
    outcome?:
      | "replayed"
      | "raw_evidence_drift"
      | "semantic_drift"
      | "enriched"
      | "unavailable"
      | "skipped";
    imported: number;
    updated: number;
    skipped: number;
    findingCount: number;
  }): Promise<void>;
  requestAuthentication(runID: string): Promise<void>;
}
