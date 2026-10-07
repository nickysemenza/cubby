// Types only, importing nothing but schema types: the global
// worker-configuration.d.ts reaches this file through worker-bindings.ts, and
// tsc re-checks the whole program after an edit to anything it reaches
// (docs/local-check-performance.md#typechecking).
import type {
  BrowserBridgeRequest,
  BrowserBridgeResult,
  BrowserBridgeRunCompletion,
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
  notifyRunCompleted(summary: BrowserBridgeRunCompletion): Promise<void>;
  requestAuthentication(runID: string): Promise<void>;
}
