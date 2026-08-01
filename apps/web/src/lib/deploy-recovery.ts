const PRELOAD_RELOAD_KEY = "cubby:preload-reload-at";
export const PRELOAD_RELOAD_COOLDOWN_MS = 60_000;

type ReloadStorage = Pick<Storage, "getItem" | "setItem">;

export type PreloadRecoveryOptions = {
  isOnline: boolean;
  storage: ReloadStorage;
  reload: () => void;
  now?: () => number;
};

/**
 * Recover an old open tab whose lazy route chunk disappeared during a deploy.
 * Returns true only when the event was suppressed in favor of a page reload.
 */
export function recoverFromPreloadError(
  event: Pick<Event, "preventDefault">,
  { isOnline, storage, reload, now = Date.now }: PreloadRecoveryOptions,
): boolean {
  if (!isOnline) return false;

  const currentTime = now();
  try {
    const previous = Number(storage.getItem(PRELOAD_RELOAD_KEY));
    if (
      Number.isFinite(previous) &&
      previous > 0 &&
      currentTime - previous < PRELOAD_RELOAD_COOLDOWN_MS
    ) {
      return false;
    }
    // Write before suppressing the error. If storage is unavailable (notably
    // some private modes), surface the original error instead of risking an
    // unbounded reload loop.
    storage.setItem(PRELOAD_RELOAD_KEY, String(currentTime));
  } catch {
    return false;
  }

  event.preventDefault();
  reload();
  return true;
}

let preloadRecoveryInstalled = false;

export function installPreloadErrorRecovery(): void {
  if (preloadRecoveryInstalled) return;
  preloadRecoveryInstalled = true;

  window.addEventListener("vite:preloadError", (event) => {
    recoverFromPreloadError(event, {
      isOnline: navigator.onLine,
      storage: window.sessionStorage,
      reload: () => window.location.reload(),
    });
  });
}
