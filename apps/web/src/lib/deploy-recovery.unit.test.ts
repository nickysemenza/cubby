import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPreloadRecovery,
  PRELOAD_RECOVERY_DELAY_MS,
  PRELOAD_RELOAD_COOLDOWN_MS,
  type PreloadRecoveryRuntime,
} from "./deploy-recovery";

function createStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
    removeItem: vi.fn(() => {
      value = null;
    }),
    value: () => value,
  };
}

function createAttempt({
  online = true,
  now = 100_000,
  storage = createStorage(),
}: {
  online?: boolean;
  now?: number;
  storage?: ReturnType<typeof createStorage>;
} = {}) {
  const reload = vi.fn();
  const runtime: PreloadRecoveryRuntime = {
    isOnline: () => online,
    storage,
    reload,
    now: () => now,
    schedule: (callback, delay) =>
      setTimeout(callback, delay) as unknown as number,
    cancel: (handle) => clearTimeout(handle),
  };
  return {
    event: { preventDefault: vi.fn() },
    recovery: createPreloadRecovery(runtime),
    reload,
    storage,
  };
}

describe("preload deployment recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("defers the first online failure and reloads exactly once", () => {
    const attempt = createAttempt();

    expect(attempt.recovery.handlePreloadError(attempt.event)).toBe(true);
    expect(attempt.event.preventDefault).toHaveBeenCalledOnce();
    expect(attempt.storage.value()).toBe("100000:1");

    vi.advanceTimersByTime(PRELOAD_RECOVERY_DELAY_MS - 1);
    expect(attempt.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(attempt.reload).toHaveBeenCalledOnce();
    vi.runOnlyPendingTimers();
    expect(attempt.reload).toHaveBeenCalledOnce();
  });

  it("coalesces repeated failures while recovery is pending", () => {
    const attempt = createAttempt();
    const repeated = { preventDefault: vi.fn() };

    expect(attempt.recovery.handlePreloadError(attempt.event)).toBe(true);
    expect(attempt.recovery.handlePreloadError(repeated)).toBe(true);

    expect(repeated.preventDefault).toHaveBeenCalledOnce();
    expect(attempt.storage.setItem).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(PRELOAD_RECOVERY_DELAY_MS);
    expect(attempt.reload).toHaveBeenCalledOnce();
  });

  it.each(["beforeunload", "pagehide"])(
    "cancels pending recovery when %s starts the document leaving",
    () => {
      const attempt = createAttempt();
      attempt.recovery.handlePreloadError(attempt.event);

      attempt.recovery.handleDocumentLeaving();
      vi.advanceTimersByTime(PRELOAD_RECOVERY_DELAY_MS);

      expect(attempt.reload).not.toHaveBeenCalled();
      expect(attempt.storage.removeItem).toHaveBeenCalledWith(
        "cubby:preload-reload-at",
      );
      expect(attempt.storage.value()).toBeNull();
    },
  );

  it("does not remove a cooldown marker it no longer owns", () => {
    const attempt = createAttempt();
    attempt.recovery.handlePreloadError(attempt.event);
    attempt.storage.setItem("cubby:preload-reload-at", "200000:other");

    attempt.recovery.handleDocumentLeaving();

    expect(attempt.storage.removeItem).not.toHaveBeenCalled();
    expect(attempt.storage.value()).toBe("200000:other");
  });

  it("enforces the cooldown after an actual reload", () => {
    const storage = createStorage();
    const first = createAttempt({ storage, now: 100_000 });
    first.recovery.handlePreloadError(first.event);
    vi.advanceTimersByTime(PRELOAD_RECOVERY_DELAY_MS);

    const repeated = createAttempt({
      storage,
      now: 100_000 + PRELOAD_RELOAD_COOLDOWN_MS - 1,
    });
    expect(repeated.recovery.handlePreloadError(repeated.event)).toBe(false);
    expect(repeated.event.preventDefault).not.toHaveBeenCalled();
    expect(repeated.reload).not.toHaveBeenCalled();
  });

  it("permits a new recovery after the cooldown", () => {
    const attempt = createAttempt({
      storage: createStorage("100000:previous"),
      now: 100_000 + PRELOAD_RELOAD_COOLDOWN_MS,
    });

    expect(attempt.recovery.handlePreloadError(attempt.event)).toBe(true);
  });

  it("does nothing while offline", () => {
    const attempt = createAttempt({ online: false });

    expect(attempt.recovery.handlePreloadError(attempt.event)).toBe(false);
    expect(attempt.storage.getItem).not.toHaveBeenCalled();
    expect(attempt.event.preventDefault).not.toHaveBeenCalled();
    expect(attempt.reload).not.toHaveBeenCalled();
  });

  it.each(["get", "set"])(
    "does not suppress when storage %s fails",
    (operation) => {
      const storage = createStorage();
      storage[operation === "get" ? "getItem" : "setItem"].mockImplementation(
        () => {
          throw new Error("storage unavailable");
        },
      );
      const attempt = createAttempt({ storage });

      expect(attempt.recovery.handlePreloadError(attempt.event)).toBe(false);
      expect(attempt.event.preventDefault).not.toHaveBeenCalled();
      expect(attempt.reload).not.toHaveBeenCalled();
    },
  );
});
