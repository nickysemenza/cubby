import { describe, expect, it, vi } from "vitest";
import {
  createCachedLoader,
  type IdlePreloadTarget,
  scheduleIdlePreload,
} from "./lazy-preload";

describe("lazy preloading", () => {
  it("loads a lazy module only once across repeated intent signals", async () => {
    const load = vi.fn(async () => ({ value: 1 }));
    const cached = createCachedLoader(load);

    const [first, second] = await Promise.all([cached(), cached()]);

    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("uses idle scheduling when available and can cancel it", () => {
    const preload = vi.fn();
    const cancelIdleCallback = vi.fn();
    const target: IdlePreloadTarget = {
      requestIdleCallback: (callback) => {
        callback();
        return 7;
      },
      cancelIdleCallback,
      setTimeout: vi.fn(() => 9),
      clearTimeout: vi.fn(),
    };

    const cancel = scheduleIdlePreload(target, preload, {
      timeoutMs: 2_000,
      fallbackMs: 500,
    });
    cancel();

    expect(preload).toHaveBeenCalledTimes(1);
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
    expect(target.setTimeout).not.toHaveBeenCalled();
  });
});
