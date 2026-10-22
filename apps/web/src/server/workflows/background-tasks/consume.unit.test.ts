import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";

import { handleBackgroundQueueMessage } from "./consume";

const unavailable = createDatabase(() => {
  throw new Error("Synthetic database unavailable");
});

describe("Job wake consumption", () => {
  it("acks failed drains; cron owns recovery when the database is unavailable", async () => {
    const message = {
      body: { version: 3, queueType: "background" },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const captureException = vi.fn();
    expect(
      await handleBackgroundQueueMessage(unavailable, message, {
        captureException,
        handlers: {},
      }),
    ).toBe("failed");
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledOnce();
  });
});
