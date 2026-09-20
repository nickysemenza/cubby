import { describe, expect, it } from "vitest";

import {
  parsePurchaseAgentEvent,
  purchaseAgentEventIdempotencyKey,
  purchaseImportAgentIdentity,
} from "./contracts";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("PurchaseAgentEvent", () => {
  it("accepts only the four continuation events", () => {
    expect(
      parsePurchaseAgentEvent({
        type: "browser_result",
        runId,
        eventId: "bridge-command-7",
        commandId: "command-7",
      }),
    ).toEqual({
      version: 1,
      type: "browser_result",
      runId,
      eventId: "bridge-command-7",
      commandId: "command-7",
    });
    expect(() =>
      parsePurchaseAgentEvent({ type: "browser_command", runId }),
    ).toThrow("Invalid input");
    expect(() =>
      parsePurchaseAgentEvent({
        type: "browser_result",
        runId,
        eventId: "event",
      }),
    ).toThrow("Invalid input");
  });

  it("uses a stable run identity and delivery idempotency key", () => {
    const event = parsePurchaseAgentEvent({
      type: "retry",
      runId,
      eventId: "retry-after-transient-failure",
      retryOf: "operation-4",
    });

    expect(purchaseImportAgentIdentity(runId)).toBe(`import-run:${runId}`);
    expect(purchaseAgentEventIdempotencyKey(event)).toBe(
      `purchase-agent:${runId}:retry:retry-after-transient-failure`,
    );
  });
});
