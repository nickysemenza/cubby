import { useCallback, useSyncExternalStore } from "react";

export type TableDensity = "comfortable" | "compact" | "dense";

const STORAGE_KEY = "table-density";
const DEFAULT_DENSITY: TableDensity = "compact";

let currentDensity: TableDensity | null = null;

function getStoredDensity(): TableDensity {
  if (currentDensity !== null) return currentDensity;
  if (typeof window === "undefined") return DEFAULT_DENSITY;
  const stored = localStorage.getItem(STORAGE_KEY);
  currentDensity =
    stored === "comfortable" || stored === "compact" || stored === "dense"
      ? stored
      : DEFAULT_DENSITY;
  return currentDensity;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): TableDensity {
  return getStoredDensity();
}

function getServerSnapshot(): TableDensity {
  return DEFAULT_DENSITY;
}

export function useTableDensity() {
  const density = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setDensity = useCallback((next: TableDensity) => {
    currentDensity = next;
    localStorage.setItem(STORAGE_KEY, next);
    for (const listener of listeners) listener();
  }, []);

  return { density, setDensity } as const;
}

// rowHeight MUST equal the rowClass/cellClass h-* pixel value — the
// virtualizer's spacer math and the fast-scroll ghost-row guides both key off
// rowHeight, and a mismatch makes them drift from the painted rows.
export const densityConfig = {
  comfortable: {
    rowHeight: 40,
    cellClass: "h-10 px-2 py-1 text-sm",
    rowClass: "h-10",
  },
  compact: {
    rowHeight: 32,
    cellClass: "h-8 px-2 py-0.5 text-sm" /* tight */,
    rowClass: "h-8",
  },
  dense: {
    rowHeight: 28,
    cellClass: "h-7 px-2 py-0.5 text-xs" /* tight */,
    rowClass: "h-7",
  },
} as const;
