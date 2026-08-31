import {
  type BackgroundQueueMessage,
  QUEUE_MESSAGE_VERSION,
} from "@cubby/schemas/queue-messages";
import type { TelemetryMessageV1 } from "@cubby/schemas/telemetry";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";
import {
  type DeadLetterQueuePorts,
  processDeadLetterBatch,
} from "~/server/dead-letter-queue";

const db = fromPartial<Database>({});

const makePorts = (
  abandon: DeadLetterQueuePorts["abandonBackgroundJob"] = vi
    .fn()
    .mockResolvedValue(true),
) => ({
  abandonBackgroundJob: abandon,
  captureException: vi.fn(),
});

/** A body no current schema accepts — an older deploy's, or a corrupted write. */
interface UnreadableBody {
  readonly nonsense: boolean;
}

const message = (
  body: BackgroundQueueMessage | TelemetryMessageV1 | UnreadableBody,
) => {
  const ack = vi.fn();
  return { message: { body, ack }, ack };
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
    const abandon = vi.fn().mockResolvedValue(true);
    const ports = makePorts(abandon);
    const { message: m, ack } = message(backgroundBody);

    await processDeadLetterBatch(
      db,
      { queue: "cubby-background-dlq", messages: [m] },
      ports,
    );

    expect(abandon).toHaveBeenCalledWith(db, "job-1", expect.any(String));
    expect(ports.captureException).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
  });

  it("acks an unreadable background message rather than looping", async () => {
    // These queues have no dead letter queue of their own, so anything other
    // than an ack either replays forever or is dropped by the platform.
    const abandon = vi.fn();
    const ports = makePorts(abandon);
    const { message: m, ack } = message({ nonsense: true });

    await processDeadLetterBatch(
      db,
      { queue: "cubby-background-dlq", messages: [m] },
      ports,
    );

    expect(abandon).not.toHaveBeenCalled();
    expect(ports.captureException).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
  });

  it("acks a telemetry dead letter without touching the database", async () => {
    const abandon = vi.fn();
    const ports = makePorts(abandon);
    const { message: m, ack } = message({
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
      db,
      { queue: "cubby-telemetry-dlq", messages: [m] },
      ports,
    );

    expect(abandon).not.toHaveBeenCalled();
    expect(ports.captureException).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
  });

  it("acks every message even when one throws", async () => {
    const abandon = vi.fn().mockRejectedValueOnce(new Error("db down"));
    const ports = makePorts(abandon);
    const first = message(backgroundBody);
    const second = message(backgroundBody);

    await processDeadLetterBatch(
      db,
      {
        queue: "cubby-background-dlq",
        messages: [first.message, second.message],
      },
      ports,
    );

    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.ack).toHaveBeenCalledOnce();
  });
});
