import { sleep } from "@cubby/shared/retry";
import { describe, expect, it, vi } from "vitest";

import { createConcurrencyLimiter } from "./concurrency-limiter";

describe("page suggestion scheduler", () => {
  // Background work must leave capacity for navigation, and queued navigation
  // must pass advisory work without interrupting a statement already running.
  it("reserves capacity and admits navigation before queued background work", async () => {
    const scheduler = createConcurrencyLimiter(2, { backgroundLimit: 1 });
    const signal = new AbortController().signal;
    const held = Promise.withResolvers<void>();
    const navigation = Promise.withResolvers<void>();
    const started: string[] = [];
    const first = scheduler.run(
      async () => {
        started.push("background");
        await held.promise;
      },
      signal,
      "background",
    );
    const second = scheduler.run(
      async () => {
        started.push("next-background");
      },
      signal,
      "background",
    );
    const interactive = scheduler.run(async () => {
      started.push("navigation");
      await navigation.promise;
    }, signal);
    await vi.waitFor(() =>
      expect(started).toEqual(["background", "navigation"]),
    );
    held.resolve();
    await vi.waitFor(() => expect(started).toContain("next-background"));
    navigation.resolve();
    await Promise.all([first, second, interactive]);
  });

  it("moves queued navigation ahead of background and cancels unstarted work", async () => {
    const scheduler = createConcurrencyLimiter(1);
    const signal = new AbortController().signal;
    const held = Promise.withResolvers<void>();
    const started: string[] = [];
    const first = scheduler.run(() => held.promise, signal);
    const cancelled = new AbortController();
    const obsolete = scheduler.run(
      async () => {
        started.push("obsolete");
      },
      cancelled.signal,
      "background",
    );
    const rejected = obsolete.catch((error: unknown) => error);
    const background = scheduler.run(
      async () => {
        started.push("background");
      },
      signal,
      "background",
    );
    const navigation = scheduler.run(async () => {
      started.push("navigation");
    }, signal);
    cancelled.abort();
    held.resolve();
    await Promise.all([first, background, navigation, rejected]);
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(started).toEqual(["navigation", "background"]);
  });

  it("starts four rows concurrently, fills released slots, and removes obsolete queued work", async () => {
    const scheduler = createConcurrencyLimiter(4);
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
      await sleep(0);
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
    const scheduler = createConcurrencyLimiter(1);
    const signal = new AbortController().signal;
    const first = scheduler.run(async () => {
      throw new Error("unavailable");
    }, signal);
    const second = scheduler.run(async () => "next", signal);
    await expect(first).rejects.toThrow("unavailable");
    await expect(second).resolves.toBe("next");
  });
});
