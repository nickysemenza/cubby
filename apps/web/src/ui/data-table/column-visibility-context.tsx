import { createContext, useContext } from "react";

/** The controller owns automatic folding independently of saved visibility. */
export const ColumnVisibilityContext = createContext<{
  emptyColumns: readonly string[];
  reveal: (ids: readonly string[]) => void;
  reset: () => void;
}>({ emptyColumns: [], reveal: () => {}, reset: () => {} });

export function useColumnVisibility() {
  return useContext(ColumnVisibilityContext);
}
