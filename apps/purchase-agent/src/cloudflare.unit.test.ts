import { describe, expect, it, vi } from "vitest";

import {
  dispatchPurchaseAgentEvent,
  type PurchaseAgentDispatch,
} from "./queue-dispatch";
import { parsePurchaseAgentEvent } from "./contracts";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("purchase-agent queue dispatch", () => {
  it("dispatches a redelivery-safe signal to the run's durable Flue instance", async () => {
    const send = vi.fn<PurchaseAgentDispatch>(async () => undefined);
    const event = parsePurchaseAgentEvent({
      type: "browser_connected",
      runId,
      eventId: "connection-9",
      connectionId: "mac-bridge-9",
    });

    await dispatchPurchaseAgentEvent(event, send);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      id: `import-run:${runId}`,
      initialData: { runId },
      idempotencyKey: `purchase-agent:${runId}:browser_connected:connection-9`,
      message: {
        kind: "signal",
        type: "purchase-import.browser_connected",
      },
    });
  });
});
