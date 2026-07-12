import type { Entity } from "@cubby/schemas/entity";
import type { OnChangeFn, VisibilityState } from "@tanstack/react-table";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

/**
 * Per-table column-visibility persistence. Same store shape as
 * `useTableDensity` (module cache + localStorage + useSyncExternalStore) but
 * keyed per entity so each list page remembers its own column set.
 *
 * Read = `{ ...initial, ...stored }`: the page's `initialColumnVisibility`
 * stays the baseline (columns added in code later default visible), and only
 * the user's toggles override it. Write = the full visibility object TanStack
 * hands back. Stale stored ids for removed columns are harmless — TanStack
 * ignores unknown column ids.
 */

type Store = {
  /** Parsed object cached for referential stability (useSyncExternalStore
   *  bails out via Object.is, so the snapshot must not re-parse per read). */
  value: VisibilityState | null | undefined;
  listeners: Set<() => void>;
};

const stores = new Map<string, Store>();

const storageKey = (entity: string) => `table-columns:${entity}`;

function getStore(entity: string): Store {
  let store = stores.get(entity);
  if (!store) {
    store = { value: undefined, listeners: new Set() };
    stores.set(entity, store);
  }
  return store;
}

function readStored(entity: string): VisibilityState | null {
  const store = getStore(entity);
  if (store.value !== undefined) return store.value;
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(storageKey(entity));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    store.value =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as VisibilityState)
        : null;
  } catch {
    store.value = null;
  }
  return store.value;
}

function writeStored(entity: string, next: VisibilityState) {
  const store = getStore(entity);
  store.value = next;
  localStorage.setItem(storageKey(entity), JSON.stringify(next));
  for (const listener of store.listeners) listener();
}

const getServerSnapshot = () => null;

export function useTableColumnVisibility(
  entity: Entity,
  initial?: VisibilityState,
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const store = getStore(entity);
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    [entity],
  );
  const getSnapshot = useCallback(() => readStored(entity), [entity]);
  const stored = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // Pages pass `initial` as a fresh object literal each render; keep the ref
  // pattern so the change handler sees the latest without destabilizing the
  // memoized visibility object below.
  const initialRef = useRef(initial);
  initialRef.current = initial;

  const columnVisibility = useMemo(
    () => ({ ...initialRef.current, ...stored }),
    [stored],
  );

  const onColumnVisibilityChange: OnChangeFn<VisibilityState> = useCallback(
    (updater) => {
      const prev = { ...initialRef.current, ...readStored(entity) };
      writeStored(
        entity,
        typeof updater === "function" ? updater(prev) : updater,
      );
    },
    [entity],
  );

  return { columnVisibility, onColumnVisibilityChange } as const;
}
