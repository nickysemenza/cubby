import { describe, expect, it, vi } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";

import { handleBackgroundQueueMessage } from "./consume";

const unavailable = createDatabase(() => {
  throw new Error("Synthetic database unavailable");
});

describe("Job wake consumption", () => {
  it("acknowledges a retired task envelope without executing a second scheduler", async () => {
    const message = {
      body: {
        version: 2,
        queueType: "background",
        task: { kind: "maintenance.recover" },
      },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    expect(
      await handleBackgroundQueueMessage(unavailable, message, {
        captureException: vi.fn(),
      }),
    ).toBe("unreadable");
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries a wake when the authoritative database cannot be reached", async () => {
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
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledOnce();
  });
});
