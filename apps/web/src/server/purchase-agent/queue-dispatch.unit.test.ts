import { describe, expect, it } from "vitest";

import { parsePurchaseAgentEvent } from "./contracts";
import { dispatchInputForEvent } from "./queue-dispatch";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("purchase-agent queue dispatch", () => {
  it("admits a redelivery-safe signal whose transcript body omits the private run id", () => {
    const event = parsePurchaseAgentEvent({
      type: "retry",
      runId,
      // A historical body: the field must not reach the member-visible transcript.
      coordinatorModel: "gpt-6-sol",
      eventId: "retry-9",
      retryOf: "operation-9",
    });

    const input = dispatchInputForEvent(event, "mail_import");

    expect(input).toEqual({
      identity: { runId, purpose: "mail_import" },
      operationId: `purchase-agent:${runId}:retry:retry-9`,
      signal: {
        type: "purchase-import.retry",
        attributes: { eventId: "retry-9" },
        body: JSON.stringify({
          version: 1,
          eventId: "retry-9",
          type: "retry",
          retryOf: "operation-9",
        }),
      },
    });
    expect(input.signal.body).not.toContain(runId);
  });
});
