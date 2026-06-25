import { useCallback, useSyncExternalStore } from "react";

export type TableDensity = "comfortable" | "compact" | "dense";

const STORAGE_KEY = "table-density";
const DEFAULT_DENSITY: TableDensity = "compact";

// Module-level state for synchronous reads across components
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

// Subscribers for useSyncExternalStore
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

export const densityConfig = {
  comfortable: {
    rowHeight: 44,
    cellClass: "h-11 px-4 py-2 text-xs",
    rowClass: "h-11",
  },
  compact: {
    rowHeight: 32,
    cellClass: "h-8 px-2 py-0.5 text-xs" /* tight */,
    rowClass: "h-8",
  },
  dense: {
    rowHeight: 28,
    cellClass: "h-7 px-1.5 py-0.5 text-2xs" /* tight */,
    rowClass: "h-7",
  },
} as const;
