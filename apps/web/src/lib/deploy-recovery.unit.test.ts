import { spawnSync } from "node:child_process";

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
    schedule: (callback, delay) => Number(setTimeout(callback, delay)),
    cancel: (handle) => clearTimeout(handle),
  };
  return {
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

    expect(attempt.recovery.handlePreloadError()).toBe("scheduled");
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

    expect(attempt.recovery.handlePreloadError()).toBe("scheduled");
    expect(attempt.recovery.handlePreloadError()).toBe("pending");

    expect(attempt.storage.setItem).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(PRELOAD_RECOVERY_DELAY_MS);
    expect(attempt.reload).toHaveBeenCalledOnce();
  });

  it.each(["beforeunload", "pagehide"])(
    "cancels pending recovery when %s starts the document leaving",
    () => {
      const attempt = createAttempt();
      attempt.recovery.handlePreloadError();

      attempt.recovery.handleDocumentLeaving();
      expect(attempt.recovery.handlePreloadError()).toBe("leaving");
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
    attempt.recovery.handlePreloadError();
    attempt.storage.setItem("cubby:preload-reload-at", "200000:other");

    attempt.recovery.handleDocumentLeaving();

    expect(attempt.storage.removeItem).not.toHaveBeenCalled();
    expect(attempt.storage.value()).toBe("200000:other");
  });

  it("enforces the cooldown after an actual reload", () => {
    const storage = createStorage();
    const first = createAttempt({ storage, now: 100_000 });
    first.recovery.handlePreloadError();
    vi.advanceTimersByTime(PRELOAD_RECOVERY_DELAY_MS);

    const repeated = createAttempt({
      storage,
      now: 100_000 + PRELOAD_RELOAD_COOLDOWN_MS - 1,
    });
    expect(repeated.recovery.handlePreloadError()).toBe("cooldown");
    expect(repeated.reload).not.toHaveBeenCalled();
  });

  it("permits a new recovery after the cooldown", () => {
    const attempt = createAttempt({
      storage: createStorage("100000:previous"),
      now: 100_000 + PRELOAD_RELOAD_COOLDOWN_MS,
    });

    expect(attempt.recovery.handlePreloadError()).toBe("scheduled");
  });

  it("does nothing while offline", () => {
    const attempt = createAttempt({ online: false });

    expect(attempt.recovery.handlePreloadError()).toBe("offline");
    expect(attempt.storage.getItem).not.toHaveBeenCalled();
    expect(attempt.reload).not.toHaveBeenCalled();
  });

  it.each(["get", "set"])(
    "does not reload when storage %s fails",
    (operation) => {
      const storage = createStorage();
      storage[operation === "get" ? "getItem" : "setItem"].mockImplementation(
        () => {
          throw new Error("storage unavailable");
        },
      );
      const attempt = createAttempt({ storage });

      expect(attempt.recovery.handlePreloadError()).toBe("storage_unavailable");
      expect(attempt.reload).not.toHaveBeenCalled();
    },
  );

  it("installs recovery when the browser denies session-storage access", () => {
    // The installer owns process-wide listeners; isolate its globals and
    // one-time installation flag from Vitest's shared module registry.
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
         import { installPreloadErrorRecovery } from ${JSON.stringify(new URL("./deploy-recovery.ts", import.meta.url).href)};
         const target = new EventTarget();
         let scheduled = 0;
         Object.defineProperties(target, {
           sessionStorage: { get() { throw new DOMException("Synthetic storage denied", "SecurityError"); } },
           setTimeout: { value() { scheduled++; return 1; } },
           clearTimeout: { value() {} },
           location: { value: { reload() { throw new Error("Unexpected reload"); } } },
         });
         globalThis.window = target;
         Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
         const decisions = [];
         installPreloadErrorRecovery((decision) => decisions.push(decision));
         const event = new Event("vite:preloadError", { cancelable: true });
         target.dispatchEvent(event);
         assert.deepEqual(decisions, ["storage_unavailable"]);
         assert.equal(event.defaultPrevented, false);
         assert.equal(scheduled, 0);`,
      ],
      { encoding: "utf8" },
    );
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
  });
});
