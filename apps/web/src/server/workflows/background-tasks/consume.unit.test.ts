import { beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";
import { productionKernel } from "~/server/kernel/kernel";

import { handleBackgroundQueueBatch } from "./consume";

const unavailable = createDatabase(() => {
  throw new Error("Synthetic database unavailable");
});

describe("permit consumption", () => {
  // Registry initialization is setup, independent of the transport retry.
  beforeAll(async () => {
    await productionKernel();
  });

  it("retries a permit whose selection cannot reach the database", async () => {
    const message = {
      body: { version: 3, queueType: "background" },
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const captureException = vi.fn();
    await handleBackgroundQueueBatch(
      unavailable,
      { queue: "cubby-background", messages: [message] },
      {
        captureException,
      },
    );
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledOnce();
  });
});
