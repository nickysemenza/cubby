import type { SearchResultItem, SearchType } from "@cubby/schemas/search";
import { searchableEntities } from "@cubby/schemas/search";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { uniq } from "es-toolkit";
import { Equal, Search } from "lucide-react";
import { useMemo } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { MobileCardSkeletonList } from "~/components/feedback/mobile-card-skeleton";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { EntityIcon, entities } from "~/entities/entities";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useIsMobile } from "~/hooks/useMobile";
import { useTRPC } from "~/integrations/trpc/react";
import { cn } from "~/lib/utils";
import { getRecents, pushRecent } from "../command-menu/recents";
import { useConversionAnswer } from "../command-menu/use-conversion-answer";
import RTable from "../data-table/Table";
import { useEntityPreview } from "../hooks/useEntityPreview";
import { searchColumns } from "./search-columns";
import {
  entityTypeMap,
  getEnrichmentText,
  getSearchMatchText,
  getSearchResultEntity,
  getSearchResultRoute,
  groupSearchResults,
  rememberSearchResult,
  SearchResultMedia,
} from "./search-utils";

interface SearchPageProps {
  query?: string;
  type: SearchType;
}

const filterOptions: Array<{ value: SearchType; label: string }> = [
  { value: "all", label: "All" },
  ...searchableEntities.map((e) => ({
    value: e as SearchType,
    label: entities[entityTypeMap[e]].label,
  })),
];

export function SearchPage({ query = "", type }: SearchPageProps) {
  const api = useTRPC();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview();

  // Search query - 50 per entity type for full search page
  const { data, isLoading, error } = useQuery({
    ...api.search.global.queryOptions({ query, limit: 50 }),
    enabled: query.length > 0,
  });

  // Inline unit answer ("250 g flour in cups") — same brain as the ⌘K console.
  const conversion = useConversionAnswer(query);

  // Entities recently jumped to from the console — shared localStorage list,
  // read once per mount (the empty state re-mounts on every visit).
  const jumps = useMemo(() => getRecents(), []);

  // Recent searches — committed on Enter so we don't record every keystroke.
  const [recents, setRecents] = useLocalStorage<string[]>(
    "cubby:recent-searches",
    [],
  );
  const commitRecent = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setRecents((prev) => uniq([trimmed, ...prev]).slice(0, 8));
  };

  // Create table instance (client-side filtering/sorting) — desktop only
  const table = useReactTable({
    data: data ?? [],
    columns: searchColumns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      columnFilters: type !== "all" ? [{ id: "entityType", value: type }] : [],
    },
  });

  // Sync URL query param with input. `viewTransition: false` + `replace`: a
  // per-keystroke search-param update must not replay the mobile page-slide
  // transition (defaultViewTransition is on globally for real navigations) or
  // push a history entry per character. Real navigations keep the slide.
  const handleSearchChange = (value: string) => {
    navigate({
      to: "/search",
      search: {
        q: value || undefined,
        type: type === "all" ? undefined : type,
      },
      viewTransition: false,
      replace: true,
    });
  };

  const handleTypeChange = (nextType: SearchType) => {
    // No `replace` here: a filter-chip click is a deliberate action, so it
    // should push history (Back undoes the filter). Still skip the view
    // transition — the mobile slide on a same-page param change is noise.
    navigate({
      to: "/search",
      search: {
        q: query || undefined,
        type: nextType === "all" ? undefined : nextType,
      },
      viewTransition: false,
    });
  };

  return (
    <Stack gap="md" className="container mx-auto p-1">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          aria-label="Search Cubby"
          placeholder="Search products, recipes, locations..."
          value={query}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRecent(e.currentTarget.value);
          }}
          className={
            "pl-10" /* tight: clears the absolute search icon at left-3 */
          }
          autoFocus
        />
      </div>

      {/* Inline unit answer — rendered above results, jumps to the ingredient */}
      {query.length > 0 && conversion && (
        <Row
          as="button"
          align="center"
          gap="md"
          type="button"
          onClick={() => {
            pushRecent({
              entityType: "ingredient",
              id: conversion.ingredientId,
              name: conversion.ingredientName,
            });
            navigate({
              to: entities.ingredient.routes.detail,
              params: { id: conversion.ingredientId },
            });
          }}
          className="w-full rounded-lg border border-[var(--border)] bg-card px-4 py-4 text-left transition-colors hover:bg-muted/50"
        >
          <Equal className="size-4 shrink-0 text-primary" />
          <span className="truncate font-mono font-semibold text-sm tabular-nums">
            {conversion.input} {conversion.ingredientName} = {conversion.result}
          </span>
          {conversion.cost && (
            <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
              ≈ {conversion.cost}
            </span>
          )}
        </Row>
      )}

      {/* Results */}
      {query.length > 0 ? (
        isMobile ? (
          <MobileSearchResults
            data={data ?? []}
            isLoading={isLoading}
            filter={type}
            onFilterChange={handleTypeChange}
          />
        ) : (
          <RTable
            table={table}
            isLoading={isLoading}
            error={error}
            ariaLabel="Search results"
            onRowClick={onRowClick}
            onRowHover={onRowHover}
          />
        )
      ) : jumps.length > 0 || recents.length > 0 ? (
        <Stack gap="md">
          {/* Entities recently jumped to — entity-inked chips, same list as ⌘K */}
          {jumps.length > 0 && (
            <Stack gap="xs">
              <span className="eyebrow px-1 font-medium">Jump back</span>
              {jumps.map((jump) => {
                const entity = entityTypeMap[jump.entityType];
                return (
                  <Row
                    as="button"
                    align="center"
                    gap="sm"
                    key={`jump-${jump.entityType}-${jump.id}`}
                    type="button"
                    onClick={() => {
                      pushRecent(jump);
                      navigate({
                        to: entities[entity].routes.detail,
                        params: { id: jump.id },
                      });
                    }}
                    className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted active:bg-muted/70"
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded",
                        entities[entity]?.color.bg ?? "bg-muted/50",
                        entities[entity]?.color.text,
                      )}
                    >
                      <EntityIcon entity={entity} className="size-3.5" />
                    </span>
                    <span className="truncate">{jump.name}</span>
                  </Row>
                );
              })}
            </Stack>
          )}
          {recents.length > 0 && (
            <Stack gap="xs">
              <Row align="center" justify="between" className="px-1">
                <span className="eyebrow font-medium">Recent</span>
                <button
                  type="button"
                  onClick={() => setRecents([])}
                  className="font-mono text-2xs text-muted-foreground uppercase hover:text-foreground"
                >
                  Clear
                </button>
              </Row>
              {recents.map((term) => (
                <Row
                  as="button"
                  align="center"
                  gap="sm"
                  key={term}
                  type="button"
                  onClick={() => handleSearchChange(term)}
                  className="w-full rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted active:bg-muted/70"
                >
                  <Search className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{term}</span>
                </Row>
              ))}
            </Stack>
          )}
        </Stack>
      ) : (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Search className="size-8 opacity-40" />
          <span className="text-sm">Start typing to search across Cubby</span>
        </div>
      )}
      <PreviewSheet />
    </Stack>
  );
}

/** Mobile-optimized search results with filter chips and grouped rows */
function MobileSearchResults({
  data,
  isLoading,
  filter,
  onFilterChange,
}: {
  data: SearchResultItem[];
  isLoading: boolean;
  filter: SearchType;
  onFilterChange: (filter: SearchType) => void;
}) {
  const navigate = useNavigate();

  // Filter data by selected type
  const filtered = useMemo(
    () =>
      filter === "all"
        ? data
        : data.filter((item) => item.entityType === filter),
    [data, filter],
  );

  const grouped = useMemo(() => groupSearchResults(filtered), [filtered]);

  return (
    <Stack gap="md">
      {/* Filter chips */}
      <Row gap="sm" className="-mx-1 overflow-x-auto px-1 pb-1">
        {filterOptions.map((opt) => {
          const isActive = filter === opt.value;
          return (
            <Badge
              key={opt.value}
              variant={isActive ? "default" : "outline"}
              className="h-auto shrink-0 cursor-pointer px-2 py-1 text-xs"
              render={
                <button
                  type="button"
                  onClick={() => onFilterChange(opt.value)}
                />
              }
            >
              {opt.label}
            </Badge>
          );
        })}
      </Row>

      {/* Results */}
      {isLoading ? (
        <MobileCardSkeletonList count={6} />
      ) : filtered.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground text-sm">
          No results found
        </div>
      ) : (
        grouped.map((group) => (
          <div key={group.entityType}>
            {/* Section header (only when showing "All") */}
            {filter === "all" && (
              <Row align="center" gap="sm" className="px-4 py-2">
                <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
                  {group.label}
                </span>
                <span className="text-muted-foreground text-xs">
                  ({group.items.length})
                </span>
              </Row>
            )}
            {group.items.map((item) => {
              const enrichment = getEnrichmentText(item);
              const matchText = getSearchMatchText(item);

              return (
                <MobileCard
                  key={`${item.entityType}-${item.id}`}
                  variant="row"
                  title={item.name}
                  subtitle={item.subtitle}
                  imageSlot={<SearchResultMedia item={item} variant="mobile" />}
                  rightValues={[enrichment, matchText].filter(
                    (value): value is string => Boolean(value),
                  )}
                  entity={getSearchResultEntity(item)}
                  onClick={() => {
                    rememberSearchResult(item);
                    navigate(getSearchResultRoute(item));
                  }}
                />
              );
            })}
          </div>
        ))
      )}
    </Stack>
  );
}
