import { useCallback, useState } from "react";
import type { ComboboxItem } from "./combobox-types";

export const pagination = {
  pageIndex: 0,
  pageSize: 20,
};

/**
 * Defer an entity-list options query until the picker is first opened (or the
 * user starts typing). Returns an `enabled` flag for the query plus the
 * `onOpenChange` handler to hand back through the render prop. Once activated it
 * stays on, so closing/reopening keeps the cached options.
 */
export function useDeferredSearch(searchQuery: string) {
  const [activated, setActivated] = useState(false);
  const onOpenChange = useCallback((open: boolean) => {
    if (open) setActivated(true);
  }, []);
  return {
    enabled: activated || searchQuery.length > 0,
    onOpenChange,
  };
}

/**
 * Custom hook for basic entity search (no dialog).
 * Use this for simple search-only scenarios or when creating entities without a dialog.
 */
export function useEntitySearch() {
  const [searchQuery, setSearchQuery] = useState("");

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  return {
    searchQuery,
    onSearchChange,
  };
}

/**
 * Custom hook for entity search with dialog-based creation.
 * Extracts common state management for search hooks that need:
 * - Search query state
 * - Dialog open/close state
 * - Promise-based dialog resolution for combobox integration
 */
export function useEntitySearchWithDialog() {
  const [searchQuery, setSearchQuery] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const [pendingResolve, setPendingResolve] = useState<
    ((item: ComboboxItem) => void) | null
  >(null);

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const openDialog = useCallback((name: string): Promise<ComboboxItem> => {
    setPendingName(name);
    setIsDialogOpen(true);
    return new Promise<ComboboxItem>((resolve) => {
      setPendingResolve(() => resolve);
    });
  }, []);

  const closeDialog = useCallback(() => {
    setIsDialogOpen(false);
    setPendingResolve(null);
  }, []);

  const resolveWithEntity = useCallback(
    (item: ComboboxItem) => {
      setIsDialogOpen(false);
      if (pendingResolve) {
        pendingResolve(item);
        setPendingResolve(null);
      }
    },
    [pendingResolve],
  );

  return {
    searchQuery,
    onSearchChange,
    isDialogOpen,
    setIsDialogOpen,
    pendingName,
    openDialog,
    closeDialog,
    resolveWithEntity,
  };
}
