import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import * as cfEnv from "~/server/cf-env";
import { runWithExecutionCtx } from "~/server/cf-env";

import { coalesceBackgroundWakes, wakeAt, wakeKernel } from "./publish";

describe("Job wake transport", () => {
  it("collapses a page's dirty, recovery and successor wakes into one permit", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const getQueue = vi
      .spyOn(cfEnv, "getBackgroundQueue")
      .mockReturnValue({ sendBatch });
    try {
      await coalesceBackgroundWakes(async () => {
        for (let i = 0; i < 256; i++) {
          await wakeKernel({ source: "synthetic.dirty" });
          await wakeAt(new Date(Date.now() + 90_000), {
            source: "synthetic.recovery",
          });
        }
        await wakeAt(new Date(), { source: "synthetic.successor" });
        expect(sendBatch).not.toHaveBeenCalled();
      });
      expect(sendBatch).toHaveBeenCalledTimes(1);
    } finally {
      getQueue.mockRestore();
    }
  });
  it("sends only a versioned permit, with no domain payload", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    await wakeKernel({ source: "synthetic-test", queue: { sendBatch } });
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { version: 3, queueType: "background" } },
    ]);
  });

  it("retains a slow wake without holding the request response open", async () => {
    const sent = Promise.withResolvers<void>();
    const retained: Promise<unknown>[] = [];
    const request = runWithExecutionCtx(
      { waitUntil: (task) => retained.push(task) },
      async () => {
        await wakeKernel({
          source: "synthetic-save",
          queue: { sendBatch: () => sent.promise },
        });
        return "saved";
      },
    );
    try {
      expect(retained).toHaveLength(1);
      await expect(request).resolves.toBe("saved");
    } finally {
      sent.resolve();
      await request;
      await Promise.all(retained);
    }
  });

  it("awaits the transport when no request owns its lifetime", async () => {
    const sent = Promise.withResolvers<void>();
    let settled = false;
    const wake = wakeKernel({
      source: "synthetic-cron",
      queue: { sendBatch: () => sent.promise },
    }).then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      sent.resolve();
      await wake;
    }
    expect(settled).toBe(true);
  });

  // A member's Run can have no other wake: without a retry here it waits for the next
  // hourly tick, because a send that failed enqueued nothing for the queue to retry.
  it("retries a failed send until the wake is delivered", async () => {
    vi.useFakeTimers();
    try {
      const sendBatch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Synthetic queue outage"))
        .mockRejectedValueOnce(new Error("Synthetic queue outage"))
        .mockResolvedValue(undefined);
      const wake = wakeKernel({ source: "run-launch", queue: { sendBatch } });
      await vi.runAllTimersAsync();
      await wake;
      expect(sendBatch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after bounded attempts and leaves the work to the hourly cron", async () => {
    vi.useFakeTimers();
    try {
      const sendBatch = vi
        .fn()
        .mockRejectedValue(new Error("Synthetic outage"));
      const wake = wakeKernel({ source: "run-launch", queue: { sendBatch } });
      await vi.runAllTimersAsync();
      await expect(wake).resolves.toBeUndefined();
      expect(sendBatch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a delayed wake with the delay still owed", async () => {
    vi.useFakeTimers();
    try {
      const sendBatch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Synthetic queue outage"))
        .mockResolvedValue(undefined);
      vi.spyOn(cfEnv, "getBackgroundQueue").mockReturnValue(
        fromPartial({ sendBatch }),
      );
      const wake = wakeAt(new Date(Date.now() + 60_000), {
        source: "synthetic-due",
      });
      await vi.runAllTimersAsync();
      await wake;
      expect(sendBatch).toHaveBeenCalledTimes(2);
      const delays = sendBatch.mock.calls.map(
        ([[message]]) => message.delaySeconds,
      );
      expect(delays[0]).toBe(60);
      expect(delays[1]).toBeLessThanOrEqual(60);
      expect(delays[1]).toBeGreaterThan(50);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
