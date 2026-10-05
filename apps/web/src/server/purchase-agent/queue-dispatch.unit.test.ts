import { describe, expect, it } from "vitest";

import { parsePurchaseAgentEvent } from "./contracts";
import { dispatchInputForEvent } from "./queue-dispatch";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("purchase-agent queue dispatch", () => {
  it("admits a redelivery-safe signal whose transcript body omits the private run id", () => {
    const event = parsePurchaseAgentEvent({
      type: "browser_connected",
      runId,
      coordinatorModel: "gpt-6-sol",
      eventId: "connection-9",
      connectionId: "mac-bridge-9",
    });

    const input = dispatchInputForEvent(event, "account_sync");

    expect(input).toEqual({
      identity: { runId, purpose: "account_sync" },
      operationId: `purchase-agent:${runId}:browser_connected:connection-9`,
      signal: {
        type: "purchase-import.browser_connected",
        attributes: { eventId: "connection-9" },
        body: JSON.stringify({
          version: 1,
          coordinatorModel: "gpt-6-sol",
          eventId: "connection-9",
          type: "browser_connected",
          connectionId: "mac-bridge-9",
        }),
      },
    });
    expect(input.signal.body).not.toContain(runId);
  });
});
