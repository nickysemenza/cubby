import { type LocationType, locationType } from "@cubby/schemas/location";
import { useCallback, useMemo } from "react";
import { z } from "zod";

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
const emptyFilterSchema = z.enum(["all", "withItems", "empty"]);
const locationTypeFilterSchema = locationType.nullable();
const galleryBooleanSchema = z.boolean();
const gallerySearchSchema = z.string();

export function useGalleryViewState() {
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage(
    "gallery-sidebar-collapsed",
    galleryBooleanSchema,
    DEFAULT_STATE.sidebarCollapsed,
  );

  const [searchTerm, setSearchTermRaw] = useLocalStorage(
    "gallery-search-term",
    gallerySearchSchema,
    "",
  );
  const [locationTypeFilter, setLocationTypeFilterRaw] = useLocalStorage(
    "gallery-type-filter",
    locationTypeFilterSchema,
    null,
  );

  const [emptyFilter, setEmptyFilterRaw] = useLocalStorage(
    "gallery-empty-filter",
    emptyFilterSchema,
    DEFAULT_STATE.emptyFilter,
  );

  const [hideNonMatching, setHideNonMatchingRaw] = useLocalStorage(
    "gallery-hide-non-matching",
    galleryBooleanSchema,
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
