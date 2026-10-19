import { useEffect } from "react";

/**
 * A column header asks the table's filter bar to open one column's editor.
 *
 * The header and the filter bar render in different subtrees and the bar is
 * the only editor owner; filter values stay in the table's URL-backed state.
 * Keyed by the table instance so two tables on a page never cross wires.
 */
type Listener = (columnId: string) => void;

const listeners = new WeakMap<object, Set<Listener>>();

export function requestColumnFilterEdit(table: object, columnId: string) {
  for (const listener of listeners.get(table) ?? []) listener(columnId);
}

/** Whether some filter bar is listening, so a header offers "Filter…" only when it can open. */
export function hasColumnFilterEditor(table: object): boolean {
  return (listeners.get(table)?.size ?? 0) > 0;
}

/** The filter bar's subscription to header requests for `table`. */
export function useColumnFilterEditRequests(
  table: object,
  onRequest: Listener,
) {
  useEffect(() => {
    const set = listeners.get(table) ?? new Set<Listener>();
    listeners.set(table, set);
    set.add(onRequest);
    return () => {
      set.delete(onRequest);
    };
  }, [table, onRequest]);
}
