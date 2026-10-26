import { describe, expect, it, vi } from "vitest";

import { runWithExecutionCtx } from "~/server/cf-env";

import { wakeJobs } from "./publish";

describe("Job wake transport", () => {
  it("sends only a versioned wake, with no domain payload", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    await wakeJobs({ source: "synthetic-test", queue: { sendBatch } });
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
        await wakeJobs({
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
    const wake = wakeJobs({
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

  it("leaves committed intent recoverable when a queue send rejects", async () => {
    await expect(
      wakeJobs({
        source: "synthetic-test",
        queue: {
          sendBatch: async () => {
            throw new Error("Synthetic unavailable queue");
          },
        },
      }),
    ).resolves.toBeUndefined();
  });
});
