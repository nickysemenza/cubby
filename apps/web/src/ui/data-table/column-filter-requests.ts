import type { RowData } from "@tanstack/react-table";
import { useEffect } from "react";

import type { CubbyTable } from "./table-features";
type Listener = (columnId: string) => void;
const listeners = new WeakMap<WeakKey, Set<Listener>>();
export function requestColumnFilterEdit<TData extends RowData>(
  table: CubbyTable<TData>,
  columnId: string,
) {
  for (const l of listeners.get(table) ?? []) l(columnId);
}
export function hasColumnFilterEditor<TData extends RowData>(
  table: CubbyTable<TData>,
): boolean {
  return (listeners.get(table)?.size ?? 0) > 0;
}
export function useColumnFilterEditRequests<TData extends RowData>(
  table: CubbyTable<TData>,
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
