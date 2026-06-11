import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/**
 * False during SSR and the initial hydration render, true afterwards.
 *
 * Branch on this instead of client-only state (e.g. the better-auth session
 * store, which can resolve before React hydrates) when the server and the
 * first client render must produce identical markup.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
