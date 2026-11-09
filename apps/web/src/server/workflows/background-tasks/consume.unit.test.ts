import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";

import { handleBackgroundQueueBatch } from "./consume";

const unavailable = createDatabase(() => {
  throw new Error("Synthetic database unavailable");
});

describe("Job wake consumption", () => {
  it("retries failed delivery when the database is unavailable", async () => {
    const message = {
      body: { version: 3, queueType: "background" },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const captureException = vi.fn();
    const sibling = { ...message, ack: vi.fn(), retry: vi.fn() };
    expect(
      await handleBackgroundQueueBatch(
        unavailable,
        { queue: "cubby-background", messages: [message, sibling] },
        {
          captureException,
          handlers: {},
        },
      ),
    ).toBeUndefined();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(sibling.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(sibling.ack).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledOnce();
    const wakes = [
      {
        body: { version: 3, queueType: "background" },
        timestamp: new Date(5_000),
        ack: vi.fn(),
        retry: vi.fn(),
      },
      {
        body: {
          version: 3,
          queueType: "background",
          afterDrain: "synthetic.late",
        },
        timestamp: new Date(3_000),
        ack: vi.fn(),
        retry: vi.fn(),
      },
      {
        body: {
          version: 3,
          queueType: "background",
          afterDrain: "synthetic.early",
        },
        timestamp: new Date(1_000),
        ack: vi.fn(),
        retry: vi.fn(),
      },
    ];
    const drained = vi.fn(async () => []);
    await handleBackgroundQueueBatch(
      unavailable,
      { queue: "cubby-background", messages: wakes },
      { captureException, drainJobs: drained },
    );
    expect(drained).toHaveBeenLastCalledWith(unavailable, {
      afterDrain: "synthetic.late",
    });
    for (const wake of wakes) {
      expect(wake.ack).toHaveBeenCalledOnce();
      expect(wake.retry).not.toHaveBeenCalled();
    }
  });
});
