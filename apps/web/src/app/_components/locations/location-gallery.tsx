import { useQuery } from "@tanstack/react-query";
import {
  type RefCallback,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import type { z } from "zod";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import {
  type EmptyFilter,
  useGalleryViewState,
} from "~/hooks/useGalleryViewState";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import type { InfLocation, LocationType } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { GalleryHeader } from "./gallery-header";
import { GallerySidebar } from "./gallery-sidebar";
import { GalleryUnifiedView } from "./gallery-unified-view";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

/** Find all location IDs matching search term (searches location names and product names) */
function findMatchingIds(
  locations: InfLocation[],
  inventoryByLocation: Map<string, InventoryItem[]>,
  searchTerm: string,
): Set<string> {
  if (!searchTerm) return new Set();

  const term = searchTerm.toLowerCase();
  const matches = new Set<string>();

  function search(locs: InfLocation[]) {
    for (const loc of locs) {
      // Check location name
      if (loc.name.toLowerCase().includes(term)) {
        matches.add(loc.id);
      }

      // Check product names in inventory
      const inventory = inventoryByLocation.get(loc.id) ?? [];
      for (const item of inventory) {
        if (item.product.name.toLowerCase().includes(term)) {
          matches.add(loc.id);
          break;
        }
      }

      if (loc.children) {
        search(loc.children);
      }
    }
  }

  search(locations);
  return matches;
}

/** Build a map from location ID to its ancestor path (for breadcrumbs) */
function buildAncestorMap(
  locations: InfLocation[],
): Map<string, InfLocation[]> {
  const map = new Map<string, InfLocation[]>();

  function traverse(locs: InfLocation[], ancestors: InfLocation[]) {
    for (const loc of locs) {
      map.set(loc.id, ancestors);
      if (loc.children) {
        traverse(loc.children, [...ancestors, loc]);
      }
    }
  }

  traverse(locations, []);
  return map;
}

/** Filter locations by type, returning both filtered tree and IDs that actually match */
function filterLocationsByType(
  locations: InfLocation[],
  typeFilter: LocationType | null,
): { filtered: InfLocation[]; matchingIds: Set<string> } {
  const matchingIds = new Set<string>();

  if (!typeFilter) return { filtered: locations, matchingIds };

  function filter(locs: InfLocation[]): InfLocation[] {
    const result: InfLocation[] = [];

    for (const loc of locs) {
      const filteredChildren = loc.children ? filter(loc.children) : [];
      const matchesType = loc.type === typeFilter;
      const hasMatchingChildren = filteredChildren.length > 0;

      if (matchesType) {
        matchingIds.add(loc.id);
      }

      if (matchesType || hasMatchingChildren) {
        result.push({
          ...loc,
          children: filteredChildren.length > 0 ? filteredChildren : undefined,
        });
      }
    }

    return result;
  }

  return { filtered: filter(locations), matchingIds };
}

/** Filter locations by empty/non-empty status, returning both filtered tree and IDs that actually match */
function filterLocationsByEmpty(
  locations: InfLocation[],
  emptyFilter: EmptyFilter,
  inventoryByLocation: Map<string, InventoryItem[]>,
): { filtered: InfLocation[]; matchingIds: Set<string> } {
  const matchingIds = new Set<string>();

  if (emptyFilter === "all") return { filtered: locations, matchingIds };

  function filter(locs: InfLocation[]): InfLocation[] {
    const result: InfLocation[] = [];

    for (const loc of locs) {
      const filteredChildren = loc.children ? filter(loc.children) : [];
      const hasItems = (inventoryByLocation.get(loc.id)?.length ?? 0) > 0;
      const matchesFilter = emptyFilter === "withItems" ? hasItems : !hasItems;
      const hasMatchingChildren = filteredChildren.length > 0;

      if (matchesFilter) {
        matchingIds.add(loc.id);
      }

      if (matchesFilter || hasMatchingChildren) {
        result.push({
          ...loc,
          children: filteredChildren.length > 0 ? filteredChildren : undefined,
        });
      }
    }

    return result;
  }

  return { filtered: filter(locations), matchingIds };
}

/** Find all location IDs matching type filter (without structural removal) */
function findTypeMatchingIds(
  locations: InfLocation[],
  typeFilter: LocationType | null,
): Set<string> {
  const matchingIds = new Set<string>();
  if (!typeFilter) return matchingIds;

  function collect(locs: InfLocation[]) {
    for (const loc of locs) {
      if (loc.type === typeFilter) {
        matchingIds.add(loc.id);
      }
      if (loc.children) {
        collect(loc.children);
      }
    }
  }

  collect(locations);
  return matchingIds;
}

/** Find all location IDs matching empty filter (without structural removal) */
function findEmptyMatchingIds(
  locations: InfLocation[],
  emptyFilter: EmptyFilter,
  inventoryByLocation: Map<string, InventoryItem[]>,
): Set<string> {
  const matchingIds = new Set<string>();
  if (emptyFilter === "all") return matchingIds;

  function collect(locs: InfLocation[]) {
    for (const loc of locs) {
      const hasItems = (inventoryByLocation.get(loc.id)?.length ?? 0) > 0;
      const matchesFilter = emptyFilter === "withItems" ? hasItems : !hasItems;
      if (matchesFilter) {
        matchingIds.add(loc.id);
      }
      if (loc.children) {
        collect(loc.children);
      }
    }
  }

  collect(locations);
  return matchingIds;
}

/** Calculate gallery stats */
function calculateStats(
  locations: InfLocation[],
  inventoryByLocation: Map<string, InventoryItem[]>,
): { locationCount: number; itemCount: number } {
  let locationCount = 0;
  let itemCount = 0;

  function traverse(locs: InfLocation[]) {
    for (const loc of locs) {
      locationCount++;
      const items = inventoryByLocation.get(loc.id) ?? [];
      itemCount += items.length;
      if (loc.children) traverse(loc.children);
    }
  }

  traverse(locations);
  return { locationCount, itemCount };
}

/**
 * Main gallery container component.
 * Orchestrates sidebar, header, and gallery views.
 */
export function LocationGallery() {
  const api = useTRPC();

  // Gallery state
  const {
    sidebarCollapsed,
    toggleSidebar,
    searchTerm,
    setSearchTerm,
    locationTypeFilter,
    setLocationTypeFilter,
    emptyFilter,
    setEmptyFilter,
    hideNonMatching,
    setHideNonMatching,
  } = useGalleryViewState();

  // Track active location for sidebar highlighting
  const [activeLocationId, setActiveLocationId] = useState<string>();

  // Refs for scroll targeting and intersection observation
  const locationRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Callback ref for main content - creates observer when element mounts
  const mainContentRef = useCallback((element: HTMLDivElement | null) => {
    // Cleanup previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (!element) return;

    // Create new observer with this element as root
    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Find the entry closest to the top of the viewport
        let topEntry: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            if (
              !topEntry ||
              entry.boundingClientRect.top < topEntry.boundingClientRect.top
            ) {
              topEntry = entry;
            }
          }
        }
        if (topEntry) {
          const locationId = (topEntry.target as HTMLElement).dataset
            .locationId;
          if (locationId) {
            setActiveLocationId(locationId);
          }
        }
      },
      {
        root: element,
        rootMargin: "-50px 0px -70% 0px",
        threshold: 0,
      },
    );

    // Observe any elements that were already registered
    locationRefs.current.forEach((el) => {
      if (el && observerRef.current) {
        observerRef.current.observe(el);
      }
    });
  }, []);

  // Callback ref factory - observes elements as they mount
  const createLocationRef = useCallback(
    (locationId: string): RefCallback<HTMLDivElement> => {
      return (element) => {
        const prevElement = locationRefs.current.get(locationId);

        // Unobserve previous element if it existed
        if (prevElement && observerRef.current) {
          observerRef.current.unobserve(prevElement);
        }

        if (element) {
          locationRefs.current.set(locationId, element);
          // Observe new element
          if (observerRef.current) {
            observerRef.current.observe(element);
          }
        } else {
          locationRefs.current.delete(locationId);
        }
      };
    },
    [],
  );

  // Fetch location tree
  const { data: locations, isLoading: locationsLoading } = useQuery(
    api.location.makeTree.queryOptions(),
  );

  // Fetch all inventory items (without location filter)
  const { data: inventoryData, isLoading: inventoryLoading } = useQuery(
    api.inventoryItem.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 10000 },
      filters: {},
    }),
  );

  // Group inventory by location ID
  const inventoryByLocation = useMemo(() => {
    const map = new Map<string, InventoryItem[]>();
    if (!inventoryData?.items) return map;

    for (const item of inventoryData.items) {
      const locationId = item.location.id;
      const existing = map.get(locationId) ?? [];
      map.set(locationId, [...existing, item]);
    }
    return map;
  }, [inventoryData]);

  // Find matching IDs for type filter (always needed for fading)
  const typeMatchingIds = useMemo(
    () => findTypeMatchingIds(locations ?? [], locationTypeFilter),
    [locations, locationTypeFilter],
  );

  // Find matching IDs for empty filter (always needed for fading)
  const emptyMatchingIds = useMemo(
    () =>
      findEmptyMatchingIds(locations ?? [], emptyFilter, inventoryByLocation),
    [locations, emptyFilter, inventoryByLocation],
  );

  // Conditionally filter locations - only structurally remove if hideNonMatching is ON
  const displayLocations = useMemo(() => {
    if (!hideNonMatching) return locations ?? [];

    // Apply structural filtering when hideNonMatching is enabled
    const { filtered: byType } = filterLocationsByType(
      locations ?? [],
      locationTypeFilter,
    );
    const { filtered } = filterLocationsByEmpty(
      byType,
      emptyFilter,
      inventoryByLocation,
    );
    return filtered;
  }, [
    locations,
    locationTypeFilter,
    emptyFilter,
    inventoryByLocation,
    hideNonMatching,
  ]);

  // Calculate stats - always use unfiltered locations so counts stay consistent
  const stats = useMemo(
    () => calculateStats(locations ?? [], inventoryByLocation),
    [locations, inventoryByLocation],
  );

  // Build ancestor map for breadcrumbs (use unfiltered locations for complete paths)
  const { ancestorMap, locationMap } = useMemo(() => {
    const ancestors = buildAncestorMap(locations ?? []);
    const locMap = new Map<string, InfLocation>();

    function flatten(locs: InfLocation[]) {
      for (const loc of locs) {
        locMap.set(loc.id, loc);
        if (loc.children) flatten(loc.children);
      }
    }
    flatten(locations ?? []);

    return { ancestorMap: ancestors, locationMap: locMap };
  }, [locations]);

  // Get breadcrumb path for active location
  const breadcrumbPath = useMemo(() => {
    if (!activeLocationId) return [];
    const ancestors = ancestorMap.get(activeLocationId) ?? [];
    const current = locationMap.get(activeLocationId);
    return current ? [...ancestors, current] : ancestors;
  }, [activeLocationId, ancestorMap, locationMap]);

  // Find matching location IDs for search
  const searchMatchingIds = useMemo(
    () => findMatchingIds(displayLocations, inventoryByLocation, searchTerm),
    [displayLocations, inventoryByLocation, searchTerm],
  );

  // Precompute faded IDs - locations that don't match all active filters
  const fadedIds = useMemo(() => {
    const hasActiveFilter =
      locationTypeFilter !== null ||
      emptyFilter !== "all" ||
      Boolean(searchTerm);

    if (!hasActiveFilter) return new Set<string>();

    const faded = new Set<string>();

    function checkLocation(locs: InfLocation[]) {
      for (const loc of locs) {
        const matchesAll =
          (!locationTypeFilter || typeMatchingIds.has(loc.id)) &&
          (emptyFilter === "all" || emptyMatchingIds.has(loc.id)) &&
          (!searchTerm || searchMatchingIds.has(loc.id));

        if (!matchesAll) faded.add(loc.id);
        if (loc.children) checkLocation(loc.children);
      }
    }

    checkLocation(displayLocations);
    return faded;
  }, [
    displayLocations,
    locationTypeFilter,
    emptyFilter,
    searchTerm,
    typeMatchingIds,
    emptyMatchingIds,
    searchMatchingIds,
  ]);

  // Scroll to location handler
  const scrollToLocation = useCallback((locationId: string) => {
    const element = locationRefs.current.get(locationId);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const isLoading = locationsLoading || inventoryLoading;

  if (isLoading) {
    return (
      <div className="flex h-[600px] items-center justify-center">
        <SimpleLoading text="Loading gallery..." />
      </div>
    );
  }

  if (!displayLocations.length) {
    return (
      <div className="flex h-[400px] flex-col items-center justify-center text-muted-foreground">
        <span className="text-lg">No locations found</span>
        {locationTypeFilter && (
          <button
            type="button"
            onClick={() => setLocationTypeFilter(null)}
            className="mt-2 text-primary text-sm hover:underline"
          >
            Clear type filter
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] overflow-hidden rounded-lg border bg-background">
      {/* Sidebar */}
      <GallerySidebar
        locations={displayLocations}
        searchTerm={searchTerm}
        onLocationClick={scrollToLocation}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        activeLocationId={activeLocationId}
        searchMatchingIds={searchMatchingIds}
        fadedIds={fadedIds}
      />

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header with breadcrumb */}
        <GalleryHeader
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          locationTypeFilter={locationTypeFilter}
          onTypeFilterChange={setLocationTypeFilter}
          emptyFilter={emptyFilter}
          onEmptyFilterChange={setEmptyFilter}
          hideNonMatching={hideNonMatching}
          onHideNonMatchingChange={setHideNonMatching}
          breadcrumbPath={breadcrumbPath}
          onBreadcrumbClick={scrollToLocation}
          stats={stats}
        />

        {/* Gallery Content */}
        <div ref={mainContentRef} className="flex-1 overflow-y-auto px-4">
          <GalleryUnifiedView
            locations={displayLocations}
            inventoryByLocation={inventoryByLocation}
            searchTerm={searchTerm}
            searchMatchingIds={searchMatchingIds}
            fadedIds={fadedIds}
            createLocationRef={createLocationRef}
          />
        </div>
      </div>
    </div>
  );
}
