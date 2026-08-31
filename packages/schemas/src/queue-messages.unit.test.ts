import { describe, expect, it } from "vitest";
import {
  backgroundQueueMessageSchema,
  QUEUE_MESSAGE_VERSION,
} from "./queue-messages";

const message = {
  version: QUEUE_MESSAGE_VERSION,
  queueType: "background" as const,
  batchId: "batch-1",
  jobId: "job-1",
  kind: "entity-embedding.refresh" as const,
};

describe("backgroundQueueMessageSchema", () => {
  it("parses a well-formed wakeup", () => {
    expect(backgroundQueueMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects a stale message version", () => {
    // Version is a literal, so the schema itself is what retires an old wire
    // format — the consumer needs no separate version comparison.
    expect(
      backgroundQueueMessageSchema.safeParse({ ...message, version: 2 })
        .success,
    ).toBe(false);
  });

  it("rejects a telemetry message on the background schema", () => {
    expect(
      backgroundQueueMessageSchema.safeParse({
        ...message,
        queueType: "telemetry",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown job kind", () => {
    expect(
      backgroundQueueMessageSchema.safeParse({ ...message, kind: "nope" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown keys so a payload cannot ride along on the wire", () => {
    // Payloads live in Postgres; keeping the message strict is what stops one
    // from being smuggled onto the queue where retries could not inspect it.
    expect(
      backgroundQueueMessageSchema.safeParse({
        ...message,
        payload: { recipeId: "r1" },
      }).success,
    ).toBe(false);
  });

  it("accepts non-uuid ids, which the Postgres lookup settles instead", () => {
    expect(
      backgroundQueueMessageSchema.safeParse({
        ...message,
        jobId: "lease-test",
      }).success,
    ).toBe(true);
  });
});
