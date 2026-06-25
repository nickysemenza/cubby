import { useEffect, useState } from "react";

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
}

/**
 * Returns `false` on the server / first render, then flips to `true` once the
 * browser is idle after mount. Use to keep non-critical fetches (e.g. the
 * problems-detector queries, which fan out 5 Worker invocations) off the
 * first-paint critical path: gate `enabled` on this so the page renders, then
 * the deferred work starts when the main thread is free.
 *
 * `requestIdleCallback` where available (Safari 16+/iOS 16+), with a short
 * `setTimeout` fallback. Starting `false` also keeps SSR markup stable — the
 * query is idle during hydration, like the existing `useHydrated` gate.
 */
export function useIdle(timeoutMs = 2000): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    const w = window as Window & IdleWindow;
    if (typeof w.requestIdleCallback === "function") {
      const id = w.requestIdleCallback(() => setIdle(true), {
        timeout: timeoutMs,
      });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = setTimeout(() => setIdle(true), 200);
    return () => clearTimeout(t);
  }, [timeoutMs]);

  return idle;
}
