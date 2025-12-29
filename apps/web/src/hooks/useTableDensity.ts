import { useLocalStorage } from "./useLocalStorage";

export type TableDensity = "normal" | "dense";

/**
 * Hook for managing table density preference
 * Persists to localStorage so the preference is remembered across sessions
 */
export function useTableDensity() {
  const [density, setDensity] = useLocalStorage<TableDensity>(
    "table-density",
    "dense",
  );
  return { density, setDensity };
}
