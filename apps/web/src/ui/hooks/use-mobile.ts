import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * Whether the viewport is phone-sized, matching the Tailwind breakpoint the
 * CSS uses.
 *
 * Reads and subscribes through the SAME `matchMedia` list. The previous
 * version seeded from `window.innerWidth` but subscribed to `matchMedia`
 * changes — and when those two disagree, the initial read wins forever: the
 * query already matches, so no `change` event is ever emitted to correct it.
 *
 * They disagree more often than you'd think — device emulation, zoom, and
 * classic scrollbars all shift `innerWidth` relative to the media query's
 * viewport width. The symptom is a page whose CSS breakpoints have all gone
 * mobile (compact nav) while anything gated on this hook stays desktop: the
 * data table renders its horizontally-scrolling desktop layout instead of the
 * card view, and the mobile filter sheet is unreachable.
 *
 * `useSyncExternalStore` also removes the mount-effect lag, so there's no
 * desktop-then-mobile flash. The server snapshot stays `false` so SSR markup
 * keeps matching the first client render.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Module-level so the callback identities are stable across renders —
// useSyncExternalStore resubscribes whenever `subscribe` changes. The
// MediaQueryList itself is NOT cached: `subscribe` closes over its own handle
// for the matching cleanup, and `getSnapshot` returns a boolean, so a fresh
// handle each call is both correct and cheap. (A cached one would also outlive
// a test's stubbed `matchMedia`.)
const subscribe = (onStoreChange: () => void): (() => void) => {
  if (!window.matchMedia) return () => {};
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => query.removeEventListener("change", onStoreChange);
};

const getSnapshot = (): boolean =>
  window.matchMedia?.(MOBILE_QUERY).matches ?? false;

const getServerSnapshot = (): boolean => false;
