import type { LocationType } from "@cubby/schemas/location";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "./useLocalStorage";

export type EmptyFilter = "all" | "withItems" | "empty";

interface GalleryViewState {
  sidebarCollapsed: boolean;
  searchTerm: string;
  locationTypeFilter: LocationType | null;
  emptyFilter: EmptyFilter;
  hideNonMatching: boolean;
}

const DEFAULT_STATE: GalleryViewState = {
  sidebarCollapsed: false,
  searchTerm: "",
  locationTypeFilter: null,
  emptyFilter: "all",
  hideNonMatching: false,
};

export function useGalleryViewState() {
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>(
    "gallery-sidebar-collapsed",
    DEFAULT_STATE.sidebarCollapsed,
  );

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

  const [hideNonMatching, setHideNonMatchingRaw] = useLocalStorage<boolean>(
    "gallery-hide-non-matching",
    DEFAULT_STATE.hideNonMatching,
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

  const setHideNonMatching = useCallback(
    (value: boolean) => {
      setHideNonMatchingRaw(value);
    },
    [setHideNonMatchingRaw],
  );

  const clearFilters = useCallback(() => {
    setSearchTermRaw("");
    setLocationTypeFilterRaw(null);
    setEmptyFilterRaw("all");
  }, [setSearchTermRaw, setLocationTypeFilterRaw, setEmptyFilterRaw]);

  return useMemo(
    () => ({
      sidebarCollapsed,
      searchTerm,
      locationTypeFilter,
      emptyFilter,
      hideNonMatching,

      setSidebarCollapsed,
      toggleSidebar,
      setSearchTerm,
      setLocationTypeFilter,
      setEmptyFilter,
      setHideNonMatching,
      clearFilters,
    }),
    [
      sidebarCollapsed,
      searchTerm,
      locationTypeFilter,
      emptyFilter,
      hideNonMatching,
      setSidebarCollapsed,
      toggleSidebar,
      setSearchTerm,
      setLocationTypeFilter,
      setEmptyFilter,
      setHideNonMatching,
      clearFilters,
    ],
  );
}
