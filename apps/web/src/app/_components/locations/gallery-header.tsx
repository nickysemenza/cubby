import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  Home,
  MapPin,
  Package,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { EmptyFilter } from "~/hooks/useGalleryViewState";
import { cn } from "~/lib/utils";
import {
  type InfLocation,
  type LocationType,
  locationTypeOptions,
} from "~/schemas/location";
import { LocationIcon } from "./location-icons";

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
        {/* Stats */}
        {stats && (
          <div className="flex items-center gap-3 border-r pr-3 text-muted-foreground text-xs">
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {stats.locationCount} locations
            </span>
            <span className="flex items-center gap-1">
              <Package className="h-3 w-3" />
              {stats.itemCount} items
            </span>
          </div>
        )}

        {/* Breadcrumb */}
        <div className="flex flex-1 items-center gap-1 overflow-hidden">
          <Home className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          {breadcrumbPath.length > 0 ? (
            breadcrumbPath.map((loc, idx) => (
              <div key={loc.id} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
                <button
                  type="button"
                  onClick={() => onBreadcrumbClick?.(loc.id)}
                  className={cn(
                    "flex items-center gap-1 rounded px-1 py-0.5 text-xs transition-colors",
                    idx === breadcrumbPath.length - 1
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <LocationIcon type={loc.type} className="h-3 w-3" />
                  <span className="max-w-[100px] truncate">{loc.name}</span>
                </button>
              </div>
            ))
          ) : (
            <span className="ml-1 text-muted-foreground text-xs">
              Scroll to see path
            </span>
          )}
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
          <Label className="text-muted-foreground">Type:</Label>
          <FilterableCombobox
            items={[{ value: "all", label: "All" }, ...locationTypeOptions]}
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
          <Label className="text-muted-foreground">Status:</Label>
          <FilterableCombobox
            items={[
              { value: "all", label: "All" },
              { value: "withItems", label: "With items" },
              { value: "empty", label: "Empty" },
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
