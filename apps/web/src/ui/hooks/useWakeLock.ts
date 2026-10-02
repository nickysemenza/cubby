import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Minimal Screen Wake Lock API surface (iOS Safari 16.4+ / most modern
 * browsers). The DOM library supplies the sentinel and manager contracts;
 * this predicate keeps the runtime feature detection at the browser seam.
 */
function hasWakeLock(
  value: Navigator | undefined,
): value is Navigator & { wakeLock: Navigator["wakeLock"] } {
  return (
    value !== undefined &&
    value.wakeLock !== undefined &&
    typeof value.wakeLock.request === "function"
  );
}

const getWakeLock = (): Navigator["wakeLock"] | undefined => {
  const navigatorValue = globalThis.navigator;
  if (!navigatorValue || !hasWakeLock(navigatorValue)) return undefined;
  return navigatorValue.wakeLock;
};

const wakeLockSupported = (): boolean => getWakeLock() !== undefined;

/**
 * Keep the screen awake while `enabled` is true — for the recipe-detail
 * "kitchen mode", where the phone sits on the counter and iOS auto-locks after
 * ~30s mid-cook.
 *
 * iOS releases the lock whenever the tab backgrounds (visibilitychange), so we
 * re-acquire on `visibilitychange` when we come back to the foreground. The API
 * is feature-detected: on an unsupported browser the hook is an inert no-op and
 * `supported` is false, so callers can hide the toggle.
 *
 * Returns `{ enabled, supported, toggle, setEnabled }`. State starts `false` so
 * the default is off and there's no SSR/first-render surprise.
 */
export interface WakeLockState {
  enabled: boolean;
  active: boolean;
  supported: boolean;
  toggle: () => void;
  setEnabled: (on: boolean) => void;
}

export function useWakeLock(): WakeLockState {
  const [enabled, setEnabled] = useState(false);
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(false);
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  // Feature-detect after mount (navigator isn't available during SSR).
  useEffect(() => {
    setSupported(wakeLockSupported());
  }, []);

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    setActive(false);
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch {
        // SILENT: a release can reject if the lock was already dropped by the
        // browser (e.g. on backgrounding). `sentinelRef` and `active` are
        // already cleared above, so there's nothing left to reconcile.
      }
    }
  }, []);

  const acquire = useCallback(async () => {
    if (!wakeLockSupported() || sentinelRef.current) return;
    try {
      const wakeLock = getWakeLock();
      if (!wakeLock) return;
      const sentinel = await wakeLock.request("screen");
      sentinelRef.current = sentinel;
      setActive(true);
    } catch {
      // SILENT: request() rejects when the document isn't visible/active; the
      // visibilitychange handler retries once we're foregrounded again.
      setActive(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !supported) {
      void release();
      return;
    }

    void acquire();

    // iOS drops the lock when the tab backgrounds; re-acquire on return.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void acquire();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void release();
    };
  }, [enabled, supported, acquire, release]);

  const toggle = useCallback(() => setEnabled((on) => !on), []);

  return { enabled, active, supported, toggle, setEnabled };
}
