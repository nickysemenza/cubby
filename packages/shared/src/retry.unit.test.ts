import { describe, expect, it, vi } from "vitest";

import { retryWithBackoff, sleep } from "./retry";

describe("retryWithBackoff", () => {
  it("retries until delayFor stops and returns the last success", async () => {
    const waits: number[] = [];
    const result = await retryWithBackoff(async (attempt) => attempt, {
      delayFor: (outcome, attempt) =>
        outcome.ok && outcome.value < 2 ? 100 * (attempt + 1) : null,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result).toBe(2);
    expect(waits).toEqual([100, 200]);
  });

  it("rethrows the original error once delayFor stops", async () => {
    const boom = new Error("boom");
    await expect(
      retryWithBackoff(
        async () => {
          throw boom;
        },
        { delayFor: () => null },
      ),
    ).rejects.toBe(boom);
  });

  it("retries a thrown error when delayFor asks for it", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return "done";
      },
      {
        delayFor: (outcome) => (outcome.ok ? null : 0),
        sleep: async () => {},
      },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
  });
});

describe("sleep", () => {
  it("rejects with the abort reason instead of resolving", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = sleep(10_000, controller.signal);
      controller.abort(new Error("deadline"));
      await expect(pending).rejects.toThrow("deadline");
    } finally {
      vi.useRealTimers();
    }
  });
});
