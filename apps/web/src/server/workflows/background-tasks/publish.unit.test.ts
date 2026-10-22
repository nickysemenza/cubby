import { describe, expect, it, vi } from "vitest";

import { wakeJobs } from "./publish";

describe("Job wake transport", () => {
  it("sends only a versioned wake, with no domain payload", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const jobId = "00000000-0000-4000-8000-000000000001";
    await wakeJobs({ source: "synthetic-test", jobId, queue: { sendBatch } });
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { version: 3, queueType: "background", jobId } },
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
