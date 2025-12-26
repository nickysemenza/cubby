"use client";

import { useCallback, useMemo } from "react";
import { useLocalStorage } from "./useLocalStorage";
import type { LocationType } from "~/schemas/location";

export type EmptyFilter = "all" | "withItems" | "empty";

interface GalleryViewState {
  sidebarCollapsed: boolean;
  searchTerm: string;
  locationTypeFilter: LocationType | null;
  emptyFilter: EmptyFilter;
}

const DEFAULT_STATE: GalleryViewState = {
  sidebarCollapsed: false,
  searchTerm: "",
  locationTypeFilter: null,
  emptyFilter: "all",
};

/**
 * Custom hook for managing gallery view state with localStorage persistence.
 * Manages sidebar collapse state, search term, and location type filter.
 */
export function useGalleryViewState() {
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>(
    "gallery-sidebar-collapsed",
    DEFAULT_STATE.sidebarCollapsed,
  );

  // Transient state (not persisted)
  const [searchTerm, setSearchTermRaw] = useLocalStorage<string>(
    "gallery-search-term",
    "",
  );
  const [locationTypeFilter, setLocationTypeFilterRaw] =
    useLocalStorage<LocationType | null>("gallery-type-filter", null);

  const [emptyFilter, setEmptyFilterRaw] = useLocalStorage<EmptyFilter>(
    "gallery-empty-filter",
    DEFAULT_STATE.emptyFilter,
  );

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  const setSearchTerm = useCallback(
    (term: string) => {
      setSearchTermRaw(term);
    },
    [setSearchTermRaw],
  );

  const setLocationTypeFilter = useCallback(
    (filter: LocationType | null) => {
      setLocationTypeFilterRaw(filter);
    },
    [setLocationTypeFilterRaw],
  );

  const setEmptyFilter = useCallback(
    (filter: EmptyFilter) => {
      setEmptyFilterRaw(filter);
    },
    [setEmptyFilterRaw],
  );

  const clearFilters = useCallback(() => {
    setSearchTermRaw("");
    setLocationTypeFilterRaw(null);
    setEmptyFilterRaw("all");
  }, [setSearchTermRaw, setLocationTypeFilterRaw, setEmptyFilterRaw]);

  return useMemo(
    () => ({
      // State
      sidebarCollapsed,
      searchTerm,
      locationTypeFilter,
      emptyFilter,

      // Actions
      setSidebarCollapsed,
      toggleSidebar,
      setSearchTerm,
      setLocationTypeFilter,
      setEmptyFilter,
      clearFilters,
    }),
    [
      sidebarCollapsed,
      searchTerm,
      locationTypeFilter,
      emptyFilter,
      setSidebarCollapsed,
      toggleSidebar,
      setSearchTerm,
      setLocationTypeFilter,
      setEmptyFilter,
      clearFilters,
    ],
  );
}
