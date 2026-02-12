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
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { MobileCardSkeletonList } from "~/components/feedback/mobile-card-skeleton";
import { Input } from "~/components/ui/input";
import { entities } from "~/entities/entities";
import { useIsMobile } from "~/hooks/useMobile";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
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
    ...api.search.global.queryOptions({
      query: query || "a",
      limit: 50,
    }),
    enabled: query.length > 0,
  });

  // Active filter for mobile (separate from table filter)
  const [mobileFilter, setMobileFilter] = useState<SearchType>(type);

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
          className="pl-10"
          autoFocus
        />
      </div>

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
      ) : (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Search className="h-8 w-8 opacity-40" />
          <span className="text-sm">
            Search products, recipes, locations...
          </span>
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
                      <img
                        src={item.imageUrl}
                        alt=""
                        className="h-11 w-11 rounded object-cover"
                      />
                    ) : (
                      <div className="flex h-11 w-11 items-center justify-center rounded bg-muted/50">
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
