import {
  browserBridgeClientMessage,
  browserBridgeResult,
  browserBridgeServerMessage,
  type BrowserBridgeRequest,
  type BrowserBridgeResult,
} from "@cubby/schemas/purchase-import";
import { z } from "zod";

export { browserBridgeResult };
export type { BrowserBridgeResult };

export const decodeBrowserBridgeMessage = (message: string | ArrayBuffer) => {
  try {
    const stringMessage = z.string().safeParse(message);
    const text = stringMessage.success
      ? stringMessage.data
      : new TextDecoder().decode(
          new Uint8Array(z.instanceof(ArrayBuffer).parse(message)),
        );
    return browserBridgeClientMessage.safeParse(JSON.parse(text));
  } catch {
    return browserBridgeClientMessage.safeParse(null);
  }
};

export const bridgeServerMessage = browserBridgeServerMessage;

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
