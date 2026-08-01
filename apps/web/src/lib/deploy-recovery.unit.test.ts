import { describe, expect, it, vi } from "vitest";
import {
  PRELOAD_RELOAD_COOLDOWN_MS,
  recoverFromPreloadError,
} from "./deploy-recovery";

function createStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
}

function createAttempt(storage = createStorage()) {
  return {
    event: { preventDefault: vi.fn() },
    reload: vi.fn(),
    storage,
  };
}

describe("preload deployment recovery", () => {
  it("suppresses and reloads the first online failure", () => {
    const attempt = createAttempt();
    expect(
      recoverFromPreloadError(attempt.event, {
        isOnline: true,
        storage: attempt.storage,
        reload: attempt.reload,
        now: () => 100_000,
      }),
    ).toBe(true);
    expect(attempt.storage.setItem).toHaveBeenCalledWith(
      "cubby:preload-reload-at",
      "100000",
    );
    expect(attempt.event.preventDefault).toHaveBeenCalledOnce();
    expect(attempt.reload).toHaveBeenCalledOnce();
  });

  it("lets a repeated failure inside 60 seconds surface normally", () => {
    const attempt = createAttempt(createStorage("100000"));
    expect(
      recoverFromPreloadError(attempt.event, {
        isOnline: true,
        storage: attempt.storage,
        reload: attempt.reload,
        now: () => 100_000 + PRELOAD_RELOAD_COOLDOWN_MS - 1,
      }),
    ).toBe(false);
    expect(attempt.event.preventDefault).not.toHaveBeenCalled();
    expect(attempt.reload).not.toHaveBeenCalled();
  });

  it("permits a new recovery after the cooldown", () => {
    const attempt = createAttempt(createStorage("100000"));
    expect(
      recoverFromPreloadError(attempt.event, {
        isOnline: true,
        storage: attempt.storage,
        reload: attempt.reload,
        now: () => 100_000 + PRELOAD_RELOAD_COOLDOWN_MS,
      }),
    ).toBe(true);
  });

  it("does nothing while offline", () => {
    const attempt = createAttempt();
    expect(
      recoverFromPreloadError(attempt.event, {
        isOnline: false,
        storage: attempt.storage,
        reload: attempt.reload,
      }),
    ).toBe(false);
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
      const attempt = createAttempt(storage);
      expect(
        recoverFromPreloadError(attempt.event, {
          isOnline: true,
          storage,
          reload: attempt.reload,
        }),
      ).toBe(false);
      expect(attempt.event.preventDefault).not.toHaveBeenCalled();
      expect(attempt.reload).not.toHaveBeenCalled();
    },
  );
});
