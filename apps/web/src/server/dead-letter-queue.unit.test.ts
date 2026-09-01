import {
  type BackgroundQueueMessage,
  QUEUE_MESSAGE_VERSION,
} from "@cubby/schemas/queue-messages";
import type { TelemetryMessageV1 } from "@cubby/schemas/telemetry";
import { describe, expect, it } from "vitest";

import {
  type DeadLetterQueuePorts,
  processDeadLetterBatch,
} from "~/server/dead-letter-queue";

type PersistedJob = {
  status: "queued" | "failed";
  lastError: string | null;
};

const inMemoryPorts = ({ failFirst = false } = {}) => {
  const jobs = new Map<string, PersistedJob>([
    ["job-1", { status: "queued", lastError: null }],
  ]);
  const capturedErrors: unknown[] = [];
  let attempts = 0;
  const ports: DeadLetterQueuePorts = {
    abandonBackgroundJob: async (jobId, reason) => {
      attempts += 1;
      if (failFirst && attempts === 1) throw new Error("db down");
      const job = jobs.get(jobId);
      if (!job || job.status === "failed") return false;
      job.status = "failed";
      job.lastError = reason;
      return true;
    },
    captureException: (error) => {
      capturedErrors.push(error);
    },
  };
  return {
    ports,
    jobs,
    capturedErrors,
    attempts: () => attempts,
  };
};

/** A body no current schema accepts — an older deploy's, or a corrupted write. */
interface UnreadableBody {
  readonly nonsense: boolean;
}

const deliveredMessage = (
  body: BackgroundQueueMessage | TelemetryMessageV1 | UnreadableBody,
) => {
  let acknowledgements = 0;
  return {
    message: {
      body,
      ack: () => {
        acknowledgements += 1;
      },
    },
    acknowledgements: () => acknowledgements,
  };
};

describe("processDeadLetterBatch", () => {
  // Annotated, not inferred: `version` would otherwise widen to `number` in a
  // mutable object literal and stop matching the schema's literal type.
  const backgroundBody: BackgroundQueueMessage = {
    version: QUEUE_MESSAGE_VERSION,
    queueType: "background",
    batchId: "batch-1",
    jobId: "job-1",
    kind: "entity-embedding.refresh",
  };

  it("settles a dead-lettered background job terminally", async () => {
    const state = inMemoryPorts();
    const delivered = deliveredMessage(backgroundBody);

    await processDeadLetterBatch(
      { queue: "cubby-background-dlq", messages: [delivered.message] },
      state.ports,
    );

    expect(state.jobs.get("job-1")).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("dead-lettered"),
    });
    expect(state.capturedErrors).toHaveLength(1);
    expect(delivered.acknowledgements()).toBe(1);
  });

  it("acks an unreadable background message rather than looping", async () => {
    const state = inMemoryPorts();
    const delivered = deliveredMessage({ nonsense: true });

    await processDeadLetterBatch(
      { queue: "cubby-background-dlq", messages: [delivered.message] },
      state.ports,
    );

    expect(state.attempts()).toBe(0);
    expect(state.jobs.get("job-1")?.status).toBe("queued");
    expect(state.capturedErrors).toHaveLength(1);
    expect(delivered.acknowledgements()).toBe(1);
  });

  it("acks a telemetry dead letter without touching persistence", async () => {
    const state = inMemoryPorts();
    const delivered = deliveredMessage({
      version: 1,
      queueType: "telemetry",
      eventId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
      occurredAt: "2026-08-02T16:00:00.000Z",
      release: "abcdef0",
      type: "mcp_tool_call",
      toolName: "search_products",
      outcome: "success",
      registeredAtCall: true,
      surface: "external_mcp",
      userId: "user_1",
      clientId: null,
    });

    await processDeadLetterBatch(
      { queue: "cubby-telemetry-dlq", messages: [delivered.message] },
      state.ports,
    );

    expect(state.attempts()).toBe(0);
    expect(state.jobs.get("job-1")?.status).toBe("queued");
    expect(state.capturedErrors).toHaveLength(1);
    expect(delivered.acknowledgements()).toBe(1);
  });

  it("acks every message even when one settlement throws", async () => {
    const state = inMemoryPorts({ failFirst: true });
    const first = deliveredMessage(backgroundBody);
    const second = deliveredMessage(backgroundBody);

    await processDeadLetterBatch(
      {
        queue: "cubby-background-dlq",
        messages: [first.message, second.message],
      },
      state.ports,
    );

    expect(state.jobs.get("job-1")?.status).toBe("failed");
    expect(state.attempts()).toBe(2);
    expect(first.acknowledgements()).toBe(1);
    expect(second.acknowledgements()).toBe(1);
  });
});
