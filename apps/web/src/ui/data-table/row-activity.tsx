import { createContext, useContext, useSyncExternalStore } from "react";

/**
 * Which row of a table is active: the last one hovered or keyboard-focused.
 * Sticky on purpose — leaving a row (say, into the portaled popover one of its
 * rail controls opened) must not unmount that control and close the popover.
 * Rows subscribe to "am I active", so a change re-renders exactly two rows.
 */
export function createRowActivityStore() {
  let activeId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    activate(id: string) {
      if (id === activeId) return;
      activeId = id;
      for (const listener of listeners) listener();
    },
    isActive: (id: string) => activeId === id,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type RowActivityStore = ReturnType<typeof createRowActivityStore>;

/** One store per table; rows rendered outside a table share a fallback. */
export const RowActivityStoreContext = createContext<RowActivityStore>(
  createRowActivityStore(),
);

/** Whether `rowId` is its table's active row, and how to make it so. */
export function useRowActivity(rowId: string) {
  const store = useContext(RowActivityStoreContext);
  const active = useSyncExternalStore(
    store.subscribe,
    () => store.isActive(rowId),
    () => false,
  );
  return { active, activate: () => store.activate(rowId) };
}

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
