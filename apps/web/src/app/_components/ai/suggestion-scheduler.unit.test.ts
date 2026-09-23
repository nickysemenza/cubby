import { describe, expect, it, vi } from "vitest";

import { createSuggestionScheduler } from "./suggestion-scheduler";

describe("page suggestion scheduler", () => {
  it("starts four rows concurrently, fills released slots, and removes obsolete queued work", async () => {
    const scheduler = createSuggestionScheduler();
    const controllers = Array.from({ length: 65 }, () => new AbortController());
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const work = controllers.map((controller, index) =>
      scheduler.run(async () => {
        started.push(index);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        return index;
      }, controller.signal),
    );
    const settled = Promise.allSettled(work);
    await vi.waitFor(() => expect(started).toHaveLength(4));
    controllers[40]!.abort();
    releases.shift()!();
    await vi.waitFor(() => expect(started).toHaveLength(5));
    expect(started).not.toContain(40);
    while (started.length < 64) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    releases.splice(0).forEach((release) => release());
    const results = await settled;
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(64);
    expect(results[40]).toMatchObject({
      status: "rejected",
      reason: { name: "AbortError" },
    });
  });

  it("a failed row releases its slot for the next request", async () => {
    const scheduler = createSuggestionScheduler(1);
    const signal = new AbortController().signal;
    const first = scheduler.run(async () => {
      throw new Error("unavailable");
    }, signal);
    const second = scheduler.run(async () => "next", signal);
    await expect(first).rejects.toThrow("unavailable");
    await expect(second).resolves.toBe("next");
  });
});
