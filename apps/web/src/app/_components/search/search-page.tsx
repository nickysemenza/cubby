import type {
  SearchableEntity,
  SearchResultItem,
  SearchType,
} from "@cubby/schemas/search";
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
import { useMemo, useState } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { MobileCardSkeletonList } from "~/components/feedback/mobile-card-skeleton";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import { EntityIcon, entities } from "~/entities/entities";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { getRecents, pushRecent } from "../command-menu/recents";
import { useConversionAnswer } from "../command-menu/use-conversion-answer";
import RTable from "../data-table/Table";
import { useEntityPreview } from "../hooks/useEntityPreview";
import { searchColumns } from "./search-columns";
import {
  entityTypeMap,
  getEnrichmentText,
  SearchResultItemIcon,
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
  const { onRowClick, PreviewSheet } = useEntityPreview();

  // Search query - 50 per entity type for full search page
  const { data, isLoading, error } = useQuery({
    ...api.search.global.queryOptions({ query, limit: 50 }),
    enabled: query.length > 0,
  });

  // Active filter for mobile (separate from table filter)
  const [mobileFilter, setMobileFilter] = useState<SearchType>(type);

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

  // Sync URL query param with input
  const handleSearchChange = (value: string) => {
    navigate({
      to: "/search",
      search: {
        q: value || undefined,
        type: type === "all" ? undefined : type,
      },
    });
  };

  return (
    <div className="container mx-auto space-y-4 p-1">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Search products, recipes, locations..."
          defaultValue={query}
          onChange={(e) => handleSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRecent(e.currentTarget.value);
          }}
          className="pl-10"
          autoFocus
        />
      </div>

      {/* Inline unit answer — rendered above results, jumps to the ingredient */}
      {query.length > 0 && conversion && (
        <button
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
          className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-all ease-cozy hover:-translate-y-0.5 hover:shadow-[var(--shadow-chunky-sm)]"
        >
          <Equal className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate font-mono font-semibold text-sm tabular-nums">
            {conversion.input} {conversion.ingredientName} = {conversion.result}
          </span>
          {conversion.cost && (
            <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
              ≈ {conversion.cost}
            </span>
          )}
        </button>
      )}

      {/* Results */}
      {query.length > 0 ? (
        isMobile ? (
          <MobileSearchResults
            data={data ?? []}
            isLoading={isLoading}
            filter={mobileFilter}
            onFilterChange={setMobileFilter}
          />
        ) : (
          <RTable
            table={table}
            isLoading={isLoading}
            error={error}
            ariaLabel="Search results"
            onRowClick={onRowClick}
          />
        )
      ) : jumps.length > 0 || recents.length > 0 ? (
        <div className="space-y-4">
          {/* Entities recently jumped to — entity-inked chips, same list as ⌘K */}
          {jumps.length > 0 && (
            <div className="space-y-1">
              <span className="eyebrow px-1 font-medium">Jump back</span>
              {jumps.map((jump) => {
                const entity = entityTypeMap[jump.entityType];
                return (
                  <button
                    key={`jump-${jump.entityType}-${jump.id}`}
                    type="button"
                    onClick={() => {
                      pushRecent(jump);
                      navigate({
                        to: entities[entity].routes.detail,
                        params: { id: jump.id },
                      });
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted active:bg-muted/70"
                  >
                    <span
                      className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded",
                        entities[entity]?.color.bg ?? "bg-muted/50",
                        entities[entity]?.color.text,
                      )}
                    >
                      <EntityIcon entity={entity} className="h-3.5 w-3.5" />
                    </span>
                    <span className="truncate">{jump.name}</span>
                  </button>
                );
              })}
            </div>
          )}
          {recents.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between px-1">
                <span className="eyebrow font-medium">Recent</span>
                <button
                  type="button"
                  onClick={() => setRecents([])}
                  className="font-mono text-2xs text-muted-foreground uppercase hover:text-foreground"
                >
                  Clear
                </button>
              </div>
              {recents.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => handleSearchChange(term)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors hover:bg-muted active:bg-muted/70"
                >
                  <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{term}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Search className="h-8 w-8 opacity-40" />
          <span className="text-sm">Start typing to search across Cubby</span>
        </div>
      )}
      <PreviewSheet />
    </div>
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

  // Group results by entity type for section headers
  const grouped = useMemo(() => {
    const groups: Array<{
      entityType: SearchableEntity;
      label: string;
      items: SearchResultItem[];
    }> = [];
    const byType = new Map<SearchableEntity, SearchResultItem[]>();

    for (const item of filtered) {
      const existing = byType.get(item.entityType);
      if (existing) {
        existing.push(item);
      } else {
        const arr = [item];
        byType.set(item.entityType, arr);
        groups.push({
          entityType: item.entityType,
          label: entities[entityTypeMap[item.entityType]].pluralLabel,
          items: arr,
        });
      }
    }

    return groups;
  }, [filtered]);

  return (
    <div className="space-y-3">
      {/* Filter chips */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {filterOptions.map((opt) => {
          const isActive = filter === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onFilterChange(opt.value)}
              className={cn(
                "shrink-0 rounded-full border px-3 py-1 font-medium text-xs transition-colors",
                isActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

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
              <div className="flex items-center gap-2 px-3 py-1.5">
                <span className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
                  {group.label}
                </span>
                <span className="text-muted-foreground/60 text-xs">
                  ({group.items.length})
                </span>
              </div>
            )}
            {group.items.map((item) => {
              const entity = entityTypeMap[item.entityType];
              const enrichment = getEnrichmentText(item);

              return (
                <MobileCard
                  key={`${item.entityType}-${item.id}`}
                  variant="row"
                  title={item.name}
                  subtitle={item.subtitle}
                  imageSlot={
                    item.imageUrl ? (
                      <div className="relative h-11 w-11 overflow-hidden rounded">
                        <Image
                          src={item.imageUrl}
                          alt=""
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      </div>
                    ) : (
                      <div
                        className={cn(
                          "flex h-11 w-11 items-center justify-center rounded",
                          entities[entity]?.color.bg ?? "bg-muted/50",
                          entities[entity]?.color.text,
                        )}
                      >
                        <SearchResultItemIcon
                          item={item}
                          className="h-5 w-5 shrink-0"
                        />
                      </div>
                    )
                  }
                  rightValues={enrichment ? [enrichment] : []}
                  entity={entity}
                  onClick={() => {
                    pushRecent({
                      entityType: item.entityType,
                      id: item.id,
                      name: item.name,
                    });
                    navigate({
                      to: entities[entity].routes.detail,
                      params: { id: item.id },
                    });
                  }}
                />
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
