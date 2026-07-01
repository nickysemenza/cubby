import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Minimal Screen Wake Lock API surface (iOS Safari 16.4+ / most modern
 * browsers). Typed locally so the hook compiles without lib.dom's optional
 * `navigator.wakeLock` (not present in every TS lib target we build against).
 */
interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
}
interface WakeLockNavigator {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
}

const wakeLockSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  typeof (navigator as unknown as WakeLockNavigator).wakeLock?.request ===
    "function";

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
export function useWakeLock(): {
  enabled: boolean;
  active: boolean;
  supported: boolean;
  toggle: () => void;
  setEnabled: (on: boolean) => void;
} {
  const [enabled, setEnabled] = useState(false);
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(false);
  const sentinelRef = useRef<WakeLockSentinelLike | null>(null);

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
        // A release can reject if the lock was already dropped by the browser
        // (e.g. on backgrounding). Nothing actionable — treat as released.
      }
    }
  }, []);

  const acquire = useCallback(async () => {
    if (!wakeLockSupported() || sentinelRef.current) return;
    try {
      const sentinel = await (
        navigator as unknown as WakeLockNavigator
      ).wakeLock!.request("screen");
      sentinelRef.current = sentinel;
      setActive(true);
    } catch {
      // request() rejects when the document isn't visible/active; the
      // visibilitychange handler will retry once we're foregrounded again.
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
