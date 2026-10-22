import { describe, expect, it, vi } from "vitest";

import { wakeJobs } from "./publish";

describe("Job wake transport", () => {
  it("sends only a versioned wake, with no domain payload", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    await wakeJobs({ source: "synthetic-test", queue: { sendBatch } });
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { version: 3, queueType: "background" } },
    ]);
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
