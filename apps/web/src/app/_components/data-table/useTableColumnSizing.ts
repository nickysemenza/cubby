import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Per-table column-width persistence, mirroring `useTableColumnVisibility`
 * (module cache + localStorage + useSyncExternalStore, keyed per table).
 *
 * Stores only USER-RESIZED columns as `{ [columnId]: pixelWidth }`. Columns
 * the user hasn't touched are absent and keep their code-defined Tailwind
 * width class. Under the table's `table-fixed` layout only the header row's
 * widths drive the columns, so applying a width to the header cell resizes the
 * whole column — no per-body-cell change (and no row-memo invalidation).
 *
 * The key is a plain string, not an `Entity`: `RTable` defaults it to its
 * `entity` prop, but surfaces with no single entity need one too (the global
 * search table lists every entity type at once). `scope` mirrors
 * `useTableColumnVisibility` — two tables over the same entity with different
 * column sets must not share widths.
 *
 * Called with `undefined` the hook is inert (empty widths, no setters), which
 * is how a table opts out without anyone writing a conditional hook call:
 * `ColumnResizeHandle` renders nothing when `setColumnSize` is absent.
 */

export const MIN_COLUMN_WIDTH = 48;

type Store = {
  value: Record<string, number> | undefined;
  listeners: Set<() => void>;
};

const stores = new Map<string, Store>();

const storageKey = (key: string) => `table-sizes:${key}`;

/** Same shape as `useTableColumnVisibility`'s scoped key. */
const scopedKey = (key: string, scope?: string) =>
  scope ? `${key}:${scope}` : key;

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

export interface TableColumnSizing {
  /** User-resized pixel widths by column id; sparse (untouched columns absent). */
  columnSizing: Record<string, number>;
  /** Absent when the table opted out — that's what disables the drag handle. */
  setColumnSize?: (columnId: string, width: number) => void;
  resetColumnSize?: (columnId: string) => void;
  resetAllColumnSizes?: () => void;
}

export function useTableColumnSizing(
  key: string | undefined,
  scope?: string,
): TableColumnSizing {
  // "" is never a real key, so an opted-out table subscribes to a store nobody
  // writes — the snapshot stays EMPTY and the setters below no-op away.
  const storeKey = key ? scopedKey(key, scope) : "";
  const subscribe = useCallback(
    (listener: () => void) => {
      const store = getStore(storeKey);
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    [storeKey],
  );
  const getSnapshot = useCallback(
    () => (storeKey ? readStored(storeKey) : EMPTY),
    [storeKey],
  );
  const columnSizing = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setColumnSize = useCallback(
    (columnId: string, width: number) => {
      if (!storeKey) return;
      const next = { ...readStored(storeKey) };
      next[columnId] = Math.max(MIN_COLUMN_WIDTH, Math.round(width));
      writeStored(storeKey, next);
    },
    [storeKey],
  );

  const resetColumnSize = useCallback(
    (columnId: string) => {
      if (!storeKey) return;
      const next = { ...readStored(storeKey) };
      delete next[columnId];
      writeStored(storeKey, next);
    },
    [storeKey],
  );

  const resetAllColumnSizes = useCallback(() => {
    if (!storeKey) return;
    writeStored(storeKey, {});
  }, [storeKey]);

  return useMemo(
    () =>
      storeKey
        ? {
            columnSizing,
            setColumnSize,
            resetColumnSize,
            resetAllColumnSizes,
          }
        : {
            columnSizing: EMPTY,
            setColumnSize: undefined,
            resetColumnSize: undefined,
            resetAllColumnSizes: undefined,
          },
    [
      storeKey,
      columnSizing,
      setColumnSize,
      resetColumnSize,
      resetAllColumnSizes,
    ],
  );
}
