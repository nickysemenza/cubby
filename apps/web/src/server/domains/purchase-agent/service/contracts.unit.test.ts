import {
  importRunAgentIdentity,
  importRunIdFromAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { describe, expect, it } from "vitest";

import { purchaseAgentEventIdempotencyKey } from "./contracts";

const runId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("PurchaseAgentEvent", () => {
  it("uses a stable run identity and delivery idempotency key", () => {
    const event = purchaseAgentEvent.parse({
      version: 1,
      type: "retry",
      runId,
      eventId: "retry-after-transient-failure",
      generation: "synthetic-generation",
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
