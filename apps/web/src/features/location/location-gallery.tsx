import type {
  InfLocation,
  InventoryItemForTree,
  LocationType,
} from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { EntityQualityFact } from "~/entity/display/data-quality-value";
import { EntityIcon } from "~/entity/entities";
import { useLocationTree } from "~/entity/hooks/use-location-tree";
import { LocationBreadcrumb } from "~/entity/presentation/location-breadcrumb";
import {
  ProductImageSummariesProvider,
  useHydratedProductImages,
} from "~/entity/presentation/product-image-summaries";
import { formatCurrency } from "~/lib/number-format";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { useIsMobile } from "~/ui/hooks/use-mobile";
import { Button } from "~/ui/primitives/button";
import { ImageWithPreview } from "~/ui/primitives/image-with-preview";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

import { GalleryHeader, type EmptyFilter } from "./gallery-header";
import { GallerySidebar } from "./gallery-sidebar";
import {
  filterLocationTree,
  indexLocations,
  locationPath,
} from "./location-browser-model";
import { LocationVisual } from "./location-visual";

export function LocationGallery() {
  const query = useLocationTree();
  const hydrated = useHydrated();
  const state = visualizationState({
    data: hydrated ? query.data : undefined,
    isLoading: !hydrated || query.isLoading,
    error: hydrated ? query.error : null,
    empty: query.data?.length === 0,
    onRetry: () => void query.refetch(),
  });
  return (
    <Visualization
      state={state}
      message="No locations yet."
      subMessage="Create a location to start browsing your household."
    >
      {query.data && <LocationBrowser data={query.data} />}
    </Visualization>
  );
}

/** A compact outline indexes one continuous gallery; disclosure only hides contents. */
export function LocationBrowser({ data }: { data: InfLocation[] }) {
  const index = useMemo(() => indexLocations(data), [data]);
  const isMobile = useIsMobile();
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>();
  const collapsed = sidebarCollapsed ?? isMobile;
  const [query, setQuery] = useState("");
  const [type, setType] = useState<LocationType | null>(null);
  const [status, setStatus] = useState<EmptyFilter>("all");
  const [selected, setSelected] = useState<string>();
  const overviewRef = useRef<HTMLElement>(null);
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  const priorSelection = useRef<string | undefined>(undefined);
  const [expanded, setExpanded] = useState(() => index.initiallyExpanded);
  const filtered = useMemo(
    () => filterLocationTree(data, { query, type, status }),
    [data, query, type, status],
  );
  const visibleIndex = useMemo(
    () => indexLocations(filtered.locations),
    [filtered.locations],
  );
  const selectedId =
    selected && visibleIndex.byId.has(selected) ? selected : undefined;
  const entries = useMemo(() => {
    const result: { location: InfLocation; depth: number }[] = [];
    const visit = (locations: InfLocation[], depth: number) => {
      for (const location of locations) {
        result.push({ location, depth });
        visit(location.children ?? [], depth + 1);
      }
    };
    visit(filtered.locations, 0);
    return result;
  }, [filtered.locations]);
  const path = locationPath(selectedId, index);

  useEffect(() => {
    const viewport = overviewRef.current;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // Sections stay in document order; find the current heading without
      // measuring every location on each frame of a large gallery scroll.
      let low = 0;
      let high = entries.length - 1;
      let active = entries[0]?.location.id;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const id = entries[middle]?.location.id;
        const section = id ? sectionRefs.current.get(id) : undefined;
        if (section && section.offsetTop <= viewport.scrollTop + 2) {
          active = id;
          low = middle + 1;
        } else high = middle - 1;
      }
      setSelected(active);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    viewport.addEventListener("scroll", schedule, { passive: true });
    const resize = () => {
      viewport.style.setProperty(
        "--gallery-height",
        `${viewport.clientHeight}px`,
      );
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(viewport);
    for (const section of sectionRefs.current.values())
      observer.observe(section);
    resize();
    return () => {
      viewport.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [entries]);

  useEffect(() => {
    if (overviewRef.current) overviewRef.current.scrollTop = 0;
  }, [query, type, status]);

  // Filtered paths are temporary. Clearing filters must not turn the same
  // selected search result into a new manual expansion.
  useEffect(() => {
    if (priorSelection.current === selectedId) return;
    priorSelection.current = selectedId;
    if (!selectedId || filtered.active) return;
    setExpanded((previous) => {
      const ancestors = locationPath(selectedId, index).slice(0, -1);
      if (ancestors.every((node) => previous.has(node.id))) return previous;
      return new Set([...previous, ...ancestors.map((node) => node.id)]);
    });
  }, [selectedId, index, filtered.active]);

  const select = (id?: string) => {
    const viewport = overviewRef.current;
    const target = id ? sectionRefs.current.get(id) : undefined;
    if (viewport) {
      viewport.scrollTo({
        top: target
          ? viewport.scrollTop +
            target.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top
          : 0,
        behavior: "instant",
      });
    }
    setSelected(id ?? entries[0]?.location.id);
    target?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
    if (isMobile) setSidebarCollapsed(true);
  };
  const toggle = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clear = () => {
    setQuery("");
    setType(null);
    setStatus("all");
  };

  return (
    <section
      aria-label="Location browser"
      className="min-w-0 border-y border-border"
    >
      <GalleryHeader
        query={query}
        onQueryChange={setQuery}
        type={type}
        onTypeChange={setType}
        status={status}
        onStatusChange={setStatus}
        onClear={clear}
      />
      <div className="flex min-w-0 flex-col md:h-[min(70vh,48rem)] md:min-h-80 md:flex-row">
        <GallerySidebar
          locations={filtered.locations}
          query={query}
          filtering={filtered.active}
          selectedId={selectedId}
          onSelect={select}
          expandedIds={filtered.active ? visibleIndex.branchIds : expanded}
          onToggle={toggle}
          collapsed={collapsed}
          onToggleCollapse={() => setSidebarCollapsed(!collapsed)}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-1 border-b border-border px-3 text-xs">
            <button
              type="button"
              onClick={() => select()}
              className="min-h-11 shrink-0 hover:underline sm:min-h-7"
            >
              All locations
            </button>
            {path.length > 0 && (
              <span aria-hidden className="text-muted-foreground">
                /
              </span>
            )}
            <LocationBreadcrumb
              segments={path.map((node) => ({
                id: node.id,
                name: node.name,
                type: node.type,
              }))}
              onSegmentClick={(id) => select(id)}
              className="max-sm:[&_button]:min-h-11 [@media(pointer:coarse)]:[&_button]:min-h-11"
              compact
            />
          </div>
          <section
            ref={overviewRef}
            aria-label="Location overview"
            className="relative h-[min(70vh,48rem)] min-h-80 min-w-0 overflow-y-auto overscroll-contain px-3 md:h-auto md:min-h-0 md:flex-1"
          >
            {filtered.locations.length === 0 ? (
              <div className="py-6 text-xs text-muted-foreground">
                <h2 className="font-medium text-foreground">
                  No matching locations
                </h2>
                <p className="mt-1">
                  Try another name, type, or contents filter.
                </p>
              </div>
            ) : (
              <div className="pb-[var(--gallery-height,70vh)]">
                {entries.map(({ location, depth }) => (
                  <section
                    key={location.id}
                    ref={(element) => {
                      if (element)
                        sectionRefs.current.set(location.id, element);
                      else sectionRefs.current.delete(location.id);
                    }}
                    aria-label={location.name}
                    style={{ marginLeft: Math.min(depth, 3) * 12 }}
                    className="border-b border-border py-2"
                  >
                    <LocationOverview location={location} query={query} />
                  </section>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}

const LocationOverview = memo(function LocationOverview({
  location,
  query,
}: {
  location: InfLocation;
  query: string;
}) {
  const [showContents, setShowContents] = useState(false);
  const items = location.inventoryItems ?? [];
  const term = query.trim().toLocaleLowerCase();
  const matchingItems = term
    ? items.filter((item) =>
        item.productName.toLocaleLowerCase().includes(term),
      )
    : items;
  const open = showContents || (Boolean(term) && matchingItems.length > 0);
  return (
    <>
      <div className="flex min-w-0 items-start gap-2">
        <LocationVisual
          location={location}
          variant="compact"
          size={32}
          showChildCount={false}
        />
        <div className="min-w-0 flex-1">
          <h2
            tabIndex={-1}
            className="text-sm font-semibold [overflow-wrap:anywhere]"
          >
            {location.name}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {location.directItemCount ?? items.length} items here ·{" "}
              {location.totalItemCount ?? items.length} total
            </span>
            {location.valuation && (
              <span>{formatCurrency(location.valuation.totalValuation)}</span>
            )}
            <EntityQualityFact
              entity="location"
              id={location.id}
              quality={location.dataQuality}
            />
          </div>
        </div>
        <Link
          to="/locations/$shortcode"
          params={{ shortcode: location.id }}
          className="flex min-h-11 shrink-0 items-center text-xs underline underline-offset-2 sm:min-h-7"
        >
          Open record
        </Link>
      </div>
      {location.images.length > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto">
          {location.images.map((image) => (
            <ImageWithPreview
              key={image.id}
              src={image.url}
              alt={`${location.name} photo`}
              to="/images/$shortcode"
              params={{ shortcode: image.id }}
              size={64}
            />
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div className="mt-1">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            disabled={Boolean(term) && matchingItems.length > 0}
            onClick={() => setShowContents(!showContents)}
            className="w-full justify-between px-2"
          >
            <span>{open ? "Hide contents" : "Show contents"}</span>
            <span className="text-2xs text-muted-foreground tabular-nums">
              {items.length} here
            </span>
          </Button>
          {open &&
            (matchingItems.length ? (
              <InventoryContents items={matchingItems} />
            ) : (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {term
                  ? "No matching contents here."
                  : "No inventory entries here."}
              </p>
            ))}
        </div>
      )}
    </>
  );
});

function InventoryContents({ items }: { items: InventoryItemForTree[] }) {
  const productIds = useMemo(
    () => items.map((item) => item.productId),
    [items],
  );
  return (
    <ProductImageSummariesProvider productIds={productIds}>
      <ul className="grid grid-cols-1 gap-x-3 sm:grid-cols-2">
        {items.map((item) => (
          <InventoryContentsRow key={item.id} item={item} />
        ))}
      </ul>
    </ProductImageSummariesProvider>
  );
}

function InventoryContentsRow({ item }: { item: InventoryItemForTree }) {
  const images = useHydratedProductImages(item.productId);
  return (
    <li className="flex min-w-0 items-center gap-2 border-t border-border px-2 py-1">
      {images[0] ? (
        <ImageWithPreview
          src={images[0].url}
          alt={item.productName}
          to="/products/$shortcode"
          params={{ shortcode: item.productId }}
          size={32}
        />
      ) : (
        <EntityIcon
          entity="inventory"
          size={14}
          className="shrink-0 text-muted-foreground"
        />
      )}
      <Link
        to="/inventory/$shortcode"
        params={{ shortcode: item.id }}
        title={item.productName}
        className="flex min-h-11 min-w-0 flex-1 items-center text-xs hover:underline sm:min-h-7"
      >
        <span className="truncate">{item.productName}</span>
      </Link>
      <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
        {item.amount.value} {item.amount.unit}
      </span>
    </li>
  );
}
