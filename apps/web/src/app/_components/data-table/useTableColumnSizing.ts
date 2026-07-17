import type { Entity } from "@cubby/schemas/entity";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Per-table column-width persistence, mirroring `useTableColumnVisibility`
 * (module cache + localStorage + useSyncExternalStore, keyed per entity).
 *
 * Stores only USER-RESIZED columns as `{ [columnId]: pixelWidth }`. Columns
 * the user hasn't touched are absent and keep their code-defined Tailwind
 * width class. Under the table's `table-fixed` layout only the header row's
 * widths drive the columns, so applying a width to the header cell resizes the
 * whole column — no per-body-cell change (and no row-memo invalidation).
 */

const MIN_COLUMN_WIDTH = 48;

type Store = {
  value: Record<string, number> | undefined;
  listeners: Set<() => void>;
};

const stores = new Map<string, Store>();

const storageKey = (entity: string) => `table-sizes:${entity}`;

function getStore(entity: string): Store {
  let store = stores.get(entity);
  if (!store) {
    store = { value: undefined, listeners: new Set() };
    stores.set(entity, store);
  }
  return store;
}

function readStored(entity: string): Record<string, number> {
  const store = getStore(entity);
  if (store.value !== undefined) return store.value;
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(storageKey(entity));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    store.value =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, number>)
        : {};
  } catch {
    store.value = {};
  }
  return store.value;
}

function writeStored(entity: string, next: Record<string, number>) {
  const store = getStore(entity);
  store.value = next;
  localStorage.setItem(storageKey(entity), JSON.stringify(next));
  for (const listener of store.listeners) listener();
}

const EMPTY: Record<string, number> = {};
const getServerSnapshot = () => EMPTY;

export function useTableColumnSizing(entity: Entity) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const store = getStore(entity);
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    [entity],
  );
  const getSnapshot = useCallback(() => readStored(entity), [entity]);
  const columnSizing = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setColumnSize = useCallback(
    (columnId: string, width: number) => {
      const next = { ...readStored(entity) };
      next[columnId] = Math.max(MIN_COLUMN_WIDTH, Math.round(width));
      writeStored(entity, next);
    },
    [entity],
  );

  const resetColumnSize = useCallback(
    (columnId: string) => {
      const next = { ...readStored(entity) };
      delete next[columnId];
      writeStored(entity, next);
    },
    [entity],
  );

  return useMemo(
    () => ({ columnSizing, setColumnSize, resetColumnSize }),
    [columnSizing, setColumnSize, resetColumnSize],
  );
}
