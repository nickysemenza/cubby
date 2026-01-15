import { useRef } from "react";

/**
 * Hook to provide stable state access in TanStack Table column cell renderers.
 *
 * TanStack Table caches column definitions, which means closures in cell renderers
 * capture stale state values. This hook wraps state in a ref that's updated each
 * render, allowing cell renderers to access the latest values.
 */
export function useStableColumnState<T>(state: T): { current: T } {
  const ref = useRef(state);
  ref.current = state;
  return ref;
}
