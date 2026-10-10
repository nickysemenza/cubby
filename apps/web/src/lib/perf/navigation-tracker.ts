import type { AnyRouter } from "@tanstack/react-router";

import { recordNavigation } from "./perf-store";

type PendingNavigation = {
  startedAt: number;
  pathname: string;
  pendingShown: boolean;
};

/**
 * Captures client-navigation time through the first paint after TanStack Router
 * renders. This is deliberately installed once with the router, not from a
 * route component, so cancelled and nested navigations share one clock.
 */
export function installNavigationTracker(router: AnyRouter): () => void {
  if (globalThis.window === undefined) return () => {};
  let pending: PendingNavigation | undefined;
  let pendingTimer: number | undefined;

  const clearPendingTimer = () => {
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    pendingTimer = undefined;
  };
  const stopBeforeNavigate = router.subscribe("onBeforeNavigate", (event) => {
    clearPendingTimer();
    pending = {
      startedAt: performance.now(),
      pathname: event.toLocation.pathname,
      pendingShown: false,
    };
    pendingTimer = window.setTimeout(() => {
      if (pending) pending.pendingShown = true;
    }, 350);
  });
  const stopRendered = router.subscribe("onRendered", () => {
    const current = pending;
    if (!current) return;
    clearPendingTimer();
    pending = undefined;
    requestAnimationFrame(() => {
      const routeId = router.state.matches.at(-1)?.routeId ?? current.pathname;
      const durationMs = performance.now() - current.startedAt;
      recordNavigation({
        routeId,
        durationMs,
        pendingShown: current.pendingShown,
      });
    });
  });
  return () => {
    clearPendingTimer();
    stopBeforeNavigate();
    stopRendered();
  };
}
