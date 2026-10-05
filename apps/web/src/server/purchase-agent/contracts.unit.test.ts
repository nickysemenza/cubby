import {
  importRunAgentIdentity,
  importRunIdFromAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { describe, expect, it } from "vitest";

import {
  parsePurchaseAgentEvent,
  purchaseAgentEventIdempotencyKey,
} from "./contracts";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("PurchaseAgentEvent", () => {
  it("switches a queued historical coordinator to the current model", () => {
    expect(
      parsePurchaseAgentEvent({
        type: "retry",
        runId,
        eventId: "historical-retry",
        coordinatorModel: "retired-model",
        retryOf: "operation-4",
      }).coordinatorModel,
    ).toBe("gpt-6-sol");
  });

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
    ).toThrow("Invalid discriminator value");
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

    expect(importRunAgentIdentity(runId, "account_sync")).toBe(
      `import-run:${runId}`,
    );
    expect(purchaseAgentEventIdempotencyKey(event)).toBe(
      `purchase-agent:${runId}:retry:retry-after-transient-failure`,
    );
  });

  it("keeps both durable prefixes and resolves photo observations", () => {
    expect(importRunAgentIdentity(runId, "purchase_validation")).toBe(
      `import-run:${runId}`,
    );
    expect(importRunAgentIdentity(runId, "product_enrichment")).toBe(
      `import-run:${runId}`,
    );
    expect(importRunAgentIdentity(runId, "photo_inventory")).toBe(
      `photo-inventory:${runId}`,
    );
    expect(importRunIdFromAgentIdentity(`photo-inventory:${runId}`)).toBe(
      runId,
    );
    expect(importRunIdFromAgentIdentity(`import-run:${runId}`)).toBe(runId);
    expect(importRunIdFromAgentIdentity(`unrelated:${runId}`)).toBeUndefined();
  });
});
