import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";

import { handleBackgroundQueueBatch } from "./consume";

const unavailable = createDatabase(() => {
  throw new Error("Synthetic database unavailable");
});

describe("permit consumption", () => {
  it("retries a permit whose selection cannot reach the database", async () => {
    const message = {
      body: { version: 3, queueType: "background" },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const captureException = vi.fn();
    const send = vi.fn();
    await handleBackgroundQueueBatch(
      unavailable,
      { queue: "cubby-background", messages: [message] },
      {
        captureException,
        runtime: (db) => ({
          db,
          handlers: {},
          drains: [],
          ports: { send, captureException },
        }),
      },
    );
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("acknowledges a retired recovery shape without running a permit", async () => {
    const message = {
      body: { version: 3, queueType: "background", recover: { ids: ["x"] } },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const send = vi.fn();
    await handleBackgroundQueueBatch(
      unavailable,
      { queue: "cubby-background", messages: [message] },
      {
        captureException: vi.fn(),
        runtime: (db) => ({
          db,
          handlers: {},
          drains: [],
          ports: { send, captureException: vi.fn() },
        }),
      },
    );
    // Running it would reach the unavailable database and retry instead.
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
