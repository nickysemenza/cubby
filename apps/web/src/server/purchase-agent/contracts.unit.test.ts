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
  it("drains a historical queue body that still names a coordinator model", () => {
    // Messages queued before the field was removed carry it and may omit the
    // version; they must parse, drop the field, and keep their idempotency key.
    const event = parsePurchaseAgentEvent(
      JSON.stringify({
        type: "retry",
        runId,
        eventId: "historical-retry",
        coordinatorModel: "retired-model",
        retryOf: "operation-4",
      }),
    );

    expect(event).toEqual({
      version: 1,
      type: "retry",
      runId,
      eventId: "historical-retry",
      retryOf: "operation-4",
    });
    expect(purchaseAgentEventIdempotencyKey(event)).toBe(
      `purchase-agent:${runId}:retry:historical-retry`,
    );
  });

  it("uses a stable run identity and delivery idempotency key", () => {
    const event = parsePurchaseAgentEvent({
      type: "retry",
      runId,
      eventId: "retry-after-transient-failure",
      retryOf: "operation-4",
    });

    expect(importRunAgentIdentity(runId, "mail_import")).toBe(
      `import-run:${runId}`,
    );
    expect(purchaseAgentEventIdempotencyKey(event)).toBe(
      `purchase-agent:${runId}:retry:retry-after-transient-failure`,
    );
  });

  it("keeps both durable prefixes and resolves photo observations", () => {
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
