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

/**
 * Hydration-stable "still loading" gate, for components whose SSR render has no
 * data but whose first client render does.
 *
 * TanStack Start's SSR-query integration streams every query the server
 * resolves and hydrates it into the client cache *before* React hydrates
 * (`router.options.hydrate` in `@tanstack/router-ssr-query-core`). A plain
 * `useQuery` gate therefore flips between the two renders that React requires
 * to be identical: the server emits its skeleton while the query is still
 * pending, and the client's very first render already sees `status: "success"`
 * and emits the content. React reports that as a hydration mismatch and throws
 * the whole tree away to re-render it on the client.
 *
 * Forcing the gate `true` until hydration finishes makes the two renders
 * identical by construction, whatever the cache happens to hold. Content still
 * appears on the render immediately after hydration: the data is already in the
 * cache, so this costs a re-render, not a fetch — and it *saves* the full-tree
 * regeneration the mismatch was causing.
 *
 * Only for gates the server genuinely renders without data. A route that awaits
 * its data in the loader already matches, and should not be routed through this.
 */
export function useHydratedLoading(isLoading: boolean): boolean {
  return !useHydrated() || isLoading;
}

/**
 * Hold an SSR-rendered control inert until React has attached its handlers.
 *
 * Streamed route content hydrates after the shell, boundary by boundary, so a
 * server-rendered button is briefly focusable yet deaf: the DOM accepts the
 * click and no `onClick` runs. Rendering it `disabled` until this component's
 * own boundary hydrates closes that window — for a person on a slow phone,
 * whose tap would otherwise vanish, and for Playwright, whose actionability
 * checks wait for `enabled` before every click and `fill`. `useHydrated` is
 * read inside the component, so it flips for the boundary that owns it rather
 * than for the shell.
 *
 * `data-hydrating` marks the pre-hydration disabled state so a primitive can
 * keep its normal look instead of flashing its disabled styling on every load.
 */
export function useHydrationGate(disabled: boolean | undefined) {
  const hydrated = useHydrated();
  const gated = !hydrated && !disabled;
  return {
    disabled: disabled || !hydrated,
    "data-hydrating": gated ? "" : undefined,
  } as const;
}
