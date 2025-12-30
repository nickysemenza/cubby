import { Link } from "@tanstack/react-router";
import { Plus, Search, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { EntityIcon } from "~/entities/entities";
import type { EmptyFilter } from "~/hooks/useGalleryViewState";
import { cn } from "~/lib/utils";
import type { InfLocation, LocationType } from "~/schemas/location";
import { LocationBreadcrumb } from "./location-breadcrumb";
import { locationTypeOptionsWithTheme } from "./location-icons";

interface GalleryHeaderProps {
  searchTerm: string;
  onSearchChange: (term: string) => void;
  locationTypeFilter: LocationType | null;
  onTypeFilterChange: (type: LocationType | null) => void;
  emptyFilter: EmptyFilter;
  onEmptyFilterChange: (filter: EmptyFilter) => void;
  breadcrumbPath?: InfLocation[];
  onBreadcrumbClick?: (locationId: string) => void;
  stats?: { locationCount: number; itemCount: number };
  className?: string;
}

export function GalleryHeader({
  searchTerm,
  onSearchChange,
  locationTypeFilter,
  onTypeFilterChange,
  emptyFilter,
  onEmptyFilterChange,
  breadcrumbPath = [],
  onBreadcrumbClick,
  stats,
  className,
}: GalleryHeaderProps) {
  const hasActiveFilters =
    searchTerm || locationTypeFilter || emptyFilter !== "all";

  return (
    <div className={cn("sticky top-0 z-10 border-b", className)}>
      {/* Stats + Breadcrumb row */}
      <div className="flex min-h-[32px] items-center gap-3 border-b bg-muted/30 px-4 py-1">
        {/* Stats - hidden on mobile */}
        {stats && (
          <div className="hidden items-center gap-3 border-r pr-3 text-muted-foreground text-xs md:flex">
            <span className="flex items-center gap-1">
              <EntityIcon entity="location" className="h-3 w-3" />
              {stats.locationCount} locations
            </span>
            <span className="flex items-center gap-1">
              <EntityIcon entity="inventory-item" className="h-3 w-3" />
              {stats.itemCount} items
            </span>
          </div>
        )}

        {/* Breadcrumb */}
        <div className="flex flex-1 items-center gap-1 overflow-hidden">
          <LocationBreadcrumb
            showHome
            segments={breadcrumbPath.map((loc) => ({
              id: loc.id,
              name: loc.name,
              type: loc.type,
            }))}
            compact
            onSegmentClick={onBreadcrumbClick}
            activeHighlight
          />
        </div>
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2 bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        {/* Search Input */}
        <div className="relative min-w-[180px] flex-1 md:max-w-xs">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 pr-7 pl-8 text-sm"
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Type Filter */}
        <div className="flex items-center gap-1.5">
          <Label className="hidden text-muted-foreground sm:inline">
            Type:
          </Label>
          <FilterableCombobox
            items={[
              { value: "all", label: "All" },
              ...locationTypeOptionsWithTheme,
            ]}
            value={locationTypeFilter ?? "all"}
            onValueChange={(value) =>
              onTypeFilterChange(
                value === "all" ? null : (value as LocationType),
              )
            }
            className="h-8 w-[120px]"
            placeholder="All"
          />
        </div>

        {/* Empty Filter */}
        <div className="flex items-center gap-1.5">
          <Label className="hidden text-muted-foreground sm:inline">
            Status:
          </Label>
          <FilterableCombobox
            items={[
              { value: "all", label: "All" },
              {
                value: "withItems",
                label: "With items",
                icon: (
                  <EntityIcon
                    entity="inventory-item"
                    size={14}
                    className="text-muted-foreground"
                  />
                ),
              },
              {
                value: "empty",
                label: "Empty",
                icon: (
                  <EntityIcon
                    entity="location"
                    size={14}
                    className="text-muted-foreground"
                  />
                ),
              },
            ]}
            value={emptyFilter}
            onValueChange={(value) =>
              onEmptyFilterChange((value ?? "all") as EmptyFilter)
            }
            className="h-8 w-[120px]"
            placeholder="All"
          />
        </div>

        {/* Clear Filters Button */}
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onSearchChange("");
              onTypeFilterChange(null);
              onEmptyFilterChange("all");
            }}
            className="h-8 px-2 text-muted-foreground text-xs"
          >
            Clear
          </Button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* New Location Button */}
        <Button
          size="sm"
          className="h-8 gap-1 text-xs"
          render={<Link to="/locations/new" />}
          nativeButton={false}
        >
          <Plus className="h-3.5 w-3.5" />
          New Location
        </Button>
      </div>
    </div>
  );
}
