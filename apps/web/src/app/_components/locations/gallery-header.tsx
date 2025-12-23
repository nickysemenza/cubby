"use client";

import {
  Search,
  X,
  ChevronRight,
  Home,
  MapPin,
  Package,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { cn } from "~/lib/utils";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  locationTypeOptions,
  type LocationType,
  type InfLocation,
} from "~/schemas/location";
import { type EmptyFilter } from "~/hooks/useGalleryViewState";
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
      <div className="bg-muted/30 flex min-h-[32px] items-center gap-3 border-b px-4 py-1">
        {/* Stats */}
        {stats && (
          <div className="flex items-center gap-3 border-r pr-3 text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {stats.locationCount}
            </span>
            <span className="text-muted-foreground flex items-center gap-1">
              <Package className="h-3 w-3" />
              {stats.itemCount}
            </span>
          </div>
        )}

        {/* Breadcrumb */}
        <div className="flex flex-1 items-center gap-1 overflow-hidden">
          <Home className="text-muted-foreground h-3 w-3 flex-shrink-0" />
          {breadcrumbPath.length > 0 ? (
            breadcrumbPath.map((loc, idx) => (
              <div key={loc.id} className="flex items-center gap-1">
                <ChevronRight className="text-muted-foreground/50 h-3 w-3 flex-shrink-0" />
                <button
                  onClick={() => onBreadcrumbClick?.(loc.id)}
                  className={cn(
                    "flex items-center gap-1 rounded px-1 py-0.5 text-xs transition-colors",
                    idx === breadcrumbPath.length - 1
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <LocationIcon type={loc.type} className="h-3 w-3" />
                  <span className="max-w-[100px] truncate">{loc.name}</span>
                </button>
              </div>
            ))
          ) : (
            <span className="text-muted-foreground ml-1 text-xs">
              Scroll to see path
            </span>
          )}
        </div>
      </div>

      {/* Controls row */}
      <div className="bg-background/95 supports-[backdrop-filter]:bg-background/60 flex flex-wrap items-center gap-2 px-4 py-2 backdrop-blur">
        {/* Search Input */}
        <div className="relative min-w-[180px] flex-1 md:max-w-xs">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
          <Input
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 pr-7 pl-8 text-sm"
          />
          {searchTerm && (
            <button
              onClick={() => onSearchChange("")}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Type Filter */}
        <Select
          value={locationTypeFilter ?? "all"}
          onValueChange={(value) =>
            onTypeFilterChange(value === "all" ? null : (value as LocationType))
          }
        >
          <SelectTrigger className="h-8 w-[120px] text-xs">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {locationTypeOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Empty Filter */}
        <Select
          value={emptyFilter}
          onValueChange={(value) => onEmptyFilterChange(value as EmptyFilter)}
        >
          <SelectTrigger className="h-8 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="withItems">With items</SelectItem>
            <SelectItem value="empty">Empty</SelectItem>
          </SelectContent>
        </Select>

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
            className="text-muted-foreground h-8 px-2 text-xs"
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
          render={<Link href="/locations/new" />}
        >
          <Plus className="h-3.5 w-3.5" />
          New Location
        </Button>
      </div>
    </div>
  );
}
