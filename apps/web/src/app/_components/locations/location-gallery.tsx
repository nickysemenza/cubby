import type {
  InfLocation,
  InventoryItemForTree,
  LocationType,
} from "@cubby/schemas/location";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type RefCallback,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

import { location } from "~/app/locations/location.functions";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { useHydratedLoading } from "~/hooks/useHydrated";
import { useIsMobile } from "~/hooks/useMobile";

import { ProductImageSummariesProvider } from "../products/product-image-summaries";
import { type EmptyFilter, GalleryHeader } from "./gallery-header";
import { GallerySidebar } from "./gallery-sidebar";
import { GalleryUnifiedView } from "./gallery-unified-view";
import { LocationGalleryCard } from "./location-gallery-card";
import { buildLocationGalleryData } from "./location-gallery-data";
import { LocationIcon } from "./location-icons";

type InventoryItem = InventoryItemForTree;
interface LocationFilterResult {
  filtered: InfLocation[];
  matchingIds: Set<string>;
}
interface GalleryStats {
  locationCount: number;
  itemCount: number;
}

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
        if (item.productName.toLowerCase().includes(term)) {
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
): LocationFilterResult {
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
): LocationFilterResult {
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
): GalleryStats {
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
  const isMobile = useIsMobile();

  // Gallery state (session-only; nothing here persists across reloads)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);
  const [searchTerm, setSearchTerm] = useState("");
  const [locationTypeFilter, setLocationTypeFilter] =
    useState<LocationType | null>(null);
  const [emptyFilter, setEmptyFilter] = useState<EmptyFilter>("all");
  const [hideNonMatching, setHideNonMatching] = useState(false);

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
          const locationId = topEntry.target.getAttribute("data-location-id");
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
    location.makeTree.queryOptions(),
  );

  // `makeTree` already contains the gallery's minimal inventory projection and
  // persisted valuations. Derive the lookup once instead of auto-paginating
  // the entire inventory table through `inventory.list`.
  const { inventoryByLocation, productIds: inventoryProductIds } = useMemo(
    () => buildLocationGalleryData(locations ?? []),
    [locations],
  );

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

  // Hydration-stable: the server renders this branch with no tree, while the
  // client's first render already has the streamed one. See useHydratedLoading.
  const isLoading = useHydratedLoading(locationsLoading);

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
            className="mt-2 text-sm text-primary hover:underline"
          >
            Clear type filter
          </button>
        )}
      </div>
    );
  }

  if (isMobile) {
    return (
      <ProductImageSummariesProvider productIds={inventoryProductIds}>
        <MobileGalleryDrillDown
          locations={displayLocations}
          inventoryByLocation={inventoryByLocation}
        />
      </ProductImageSummariesProvider>
    );
  }

  return (
    <ProductImageSummariesProvider productIds={inventoryProductIds}>
      <div className="flex h-[calc(100vh-12rem)] overflow-hidden border border-[var(--border)] bg-background">
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

        <div className="flex flex-1 flex-col overflow-hidden">
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
    </ProductImageSummariesProvider>
  );
}

/**
 * Mobile drill-down gallery. Shows a 2-column grid of location cards.
 * Tapping a location with children drills into it; leaf locations navigate to detail.
 */
function MobileGalleryDrillDown({
  locations,
  inventoryByLocation,
}: {
  locations: InfLocation[];
  inventoryByLocation: Map<string, InventoryItem[]>;
}) {
  const navigate = useNavigate();
  const [path, setPath] = useState<InfLocation[]>([]);

  // Current level: root or drilled-in children
  const currentLocations =
    path.length === 0 ? locations : (path[path.length - 1]!.children ?? []);

  const handleTap = useCallback(
    (location: InfLocation) => {
      if (location.children && location.children.length > 0) {
        setPath((prev) => [...prev, location]);
      } else {
        navigate({
          to: "/locations/$shortcode",
          params: { shortcode: location.id },
        });
      }
    },
    [navigate],
  );

  const handleBack = useCallback(() => {
    setPath((prev) => prev.slice(0, -1));
  }, []);

  return (
    <Stack gap="md">
      {/* Breadcrumb navigation */}
      {path.length > 0 && (
        <Row align="center" gap="xs" className="text-sm">
          <Button variant="ghost" onClick={handleBack}>
            <CaretLeftIcon className="size-4" />
            Back
          </Button>
          <Row align="center" gap="xs" className="text-muted-foreground">
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() => setPath([])}
            >
              All
            </button>
            {path.map((loc, i) => (
              <Row as="span" key={loc.id} align="center" gap="xs">
                <span>/</span>
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => setPath((prev) => prev.slice(0, i + 1))}
                >
                  {loc.name}
                </button>
              </Row>
            ))}
          </Row>
        </Row>
      )}

      {/* 2-column card grid */}
      {currentLocations.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {currentLocations.map((location) => {
            const hasChildren = (location.children?.length ?? 0) > 0;
            return (
              <button
                type="button"
                key={location.id}
                className="text-left"
                onClick={() => handleTap(location)}
              >
                <LocationGalleryCard
                  location={location}
                  inventoryItems={inventoryByLocation.get(location.id) ?? []}
                />
                {hasChildren && (
                  <Description as="div" size="2xs" className="mt-1 text-center">
                    {location.children!.length} sub-location
                    {location.children!.length !== 1 ? "s" : ""}
                  </Description>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <LocationIcon
            type="room"
            product={null}
            className="mb-2 size-8 opacity-40"
          />
          <span>No locations here</span>
        </div>
      )}
    </Stack>
  );
}
