const PRELOAD_RELOAD_KEY = "cubby:preload-reload-at";
export const PRELOAD_RELOAD_COOLDOWN_MS = 60_000;
export const PRELOAD_RECOVERY_DELAY_MS = 250;

type ReloadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type TimerHandle = number;
type ReloadAttempt = { marker: string; timer?: TimerHandle };

export interface PreloadRecoveryRuntime {
  isOnline: () => boolean;
  storage: ReloadStorage;
  reload: () => void;
  now: () => number;
  schedule: (callback: () => void, delay: number) => TimerHandle;
  cancel: (handle: TimerHandle) => void;
}

export interface PreloadRecovery {
  handlePreloadError: () =>
    | "scheduled"
    | "pending"
    | "leaving"
    | "offline"
    | "cooldown"
    | "storage_unavailable"
    | "schedule_failed";
  handleDocumentLeaving: () => void;
}

function recordedAt(value: string | null): number {
  return Number(value?.split(":", 1)[0]);
}

/**
 * Coordinate deploy recovery without racing a document navigation that caused
 * an in-flight route preload to be cancelled.
 */
export function createPreloadRecovery(
  runtime: PreloadRecoveryRuntime,
): PreloadRecovery {
  let attemptSequence = 0;
  let documentLeaving = false;
  let pending: ReloadAttempt | undefined;

  const removeOwnedMarker = (marker: string) => {
    try {
      if (runtime.storage.getItem(PRELOAD_RELOAD_KEY) === marker) {
        runtime.storage.removeItem(PRELOAD_RELOAD_KEY);
      }
    } catch {
      // SILENT: the document is already leaving. A stale cooldown marker is
      // safer than risking a reload loop when session storage becomes
      // unavailable mid-navigation.
    }
  };

  return {
    handlePreloadError() {
      if (documentLeaving) return "leaving";

      if (pending) return "pending";

      if (!runtime.isOnline()) return "offline";

      const currentTime = runtime.now();
      attemptSequence += 1;
      const marker = `${currentTime}:${attemptSequence}`;
      try {
        const previous = recordedAt(
          runtime.storage.getItem(PRELOAD_RELOAD_KEY),
        );
        if (
          Number.isFinite(previous) &&
          previous > 0 &&
          currentTime - previous < PRELOAD_RELOAD_COOLDOWN_MS
        ) {
          return "cooldown";
        }
        // Record the attempt before scheduling so unavailable storage cannot
        // turn repeated failures into an unbounded reload loop.
        runtime.storage.setItem(PRELOAD_RELOAD_KEY, marker);
      } catch {
        return "storage_unavailable";
      }

      const attempt: ReloadAttempt = {
        marker,
      };
      try {
        attempt.timer = runtime.schedule(() => {
          if (pending !== attempt) return;
          pending = undefined;
          runtime.reload();
        }, PRELOAD_RECOVERY_DELAY_MS);
      } catch {
        removeOwnedMarker(marker);
        return "schedule_failed";
      }

      pending = attempt;
      return "scheduled";
    },

    handleDocumentLeaving() {
      documentLeaving = true;
      if (!pending) return;

      const attempt = pending;
      pending = undefined;
      if (attempt.timer !== undefined) runtime.cancel(attempt.timer);
      removeOwnedMarker(attempt.marker);
    },
  };
}

let preloadRecoveryInstalled = false;

export function installPreloadErrorRecovery(
  recordDecision: (
    decision: ReturnType<PreloadRecovery["handlePreloadError"]>,
  ) => void,
): void {
  if (preloadRecoveryInstalled) return;
  preloadRecoveryInstalled = true;

  const recovery = createPreloadRecovery({
    isOnline: () => navigator.onLine,
    // Access itself can throw, before getItem/setItem. Keep it inside the
    // controller's storage guard so denied storage cannot break router setup.
    storage: {
      getItem: (key) => window.sessionStorage.getItem(key),
      setItem: (key, value) => window.sessionStorage.setItem(key, value),
      removeItem: (key) => window.sessionStorage.removeItem(key),
    },
    reload: () => window.location.reload(),
    now: Date.now,
    schedule: (callback, delay) => window.setTimeout(callback, delay),
    cancel: (handle) => window.clearTimeout(handle),
  });

  window.addEventListener("vite:preloadError", () => {
    // Preventing Vite's event makes a rejected import fulfill with undefined,
    // which breaks lazy module consumers before the delayed reload.
    recordDecision(recovery.handlePreloadError());
  });
  window.addEventListener("beforeunload", recovery.handleDocumentLeaving);
  window.addEventListener("pagehide", recovery.handleDocumentLeaving);
}
