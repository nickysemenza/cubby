import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Whether the surrounding table row is the one being worked in (hovered,
 * keyboard-focused, or the inspector's current record). Cells mount their
 * hover-only controls — edit pencil, field explanation, quiet suggestion
 * status — only while this is true: a 50-row related table used to carry
 * ~290 DOM nodes per row, mostly controls nobody could see, and scrolled at
 * ~25 ms per frame. Outside a table row (detail facts, dialogs, cards) there
 * is no provider and controls stay mounted.
 */
const RowActiveContext = createContext(true);

export const RowActiveProvider = RowActiveContext.Provider;

export function useRowActive(): boolean {
  return useContext(RowActiveContext);
}

const COARSE_POINTER = "(pointer: coarse)";
const subscribeCoarse = (onChange: () => void) => {
  const query = globalThis.matchMedia?.(COARSE_POINTER);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
};

/** Touch has no hover, so every row keeps its controls on coarse pointers. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () => globalThis.matchMedia?.(COARSE_POINTER).matches ?? false,
    () => false,
  );
}
