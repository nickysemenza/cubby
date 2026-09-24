import {
  type InfLocation,
  type LocationType,
  locationType,
} from "@cubby/schemas/location";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";
import { useId, useState } from "react";
import { z } from "zod";

import { EntityStat } from "~/components/entity/entity-stat";
import { Row } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { FilterableCombobox } from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { captureRequest } from "~/entities/editing/editor-requests";
import { EntityEditDialog } from "~/entities/editing/entity-edit-dialog";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";

import { LocationBreadcrumb } from "./location-breadcrumb";
import { locationTypeOptionsWithTheme } from "./location-icons";

const EMPTY_BREADCRUMB: InfLocation[] = [];
const emptyFilterSchema = z.enum(["all", "withItems", "empty"]);
export type EmptyFilter = z.infer<typeof emptyFilterSchema>;

interface GalleryHeaderProps {
  searchTerm: string;
  onSearchChange: (term: string) => void;
  locationTypeFilter: LocationType | null;
  onTypeFilterChange: (type: LocationType | null) => void;
  emptyFilter: EmptyFilter;
  onEmptyFilterChange: (filter: EmptyFilter) => void;
  hideNonMatching: boolean;
  onHideNonMatchingChange: (value: boolean) => void;
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
  hideNonMatching,
  onHideNonMatchingChange,
  breadcrumbPath = EMPTY_BREADCRUMB,
  onBreadcrumbClick,
  stats,
  className,
}: GalleryHeaderProps) {
  const hideNonMatchingId = useId();
  const hasActiveFilters =
    searchTerm || locationTypeFilter || emptyFilter !== "all";
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className={cn("sticky top-0 z-10 border-b", className)}>
      <Row
        align="center"
        gap="sm"
        className="min-h-[32px] border-b bg-muted/30 px-4 py-1"
      >
        {stats && (
          <div className="hidden items-center gap-2 border-r pr-2 text-xs text-muted-foreground md:flex">
            <EntityStat
              entity="location"
              count={stats.locationCount}
              label="locations"
            />
            <EntityStat
              entity="inventory"
              count={stats.itemCount}
              label="items"
            />
          </div>
        )}

        <Row align="center" gap="xs" className="flex-1 overflow-hidden">
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
        </Row>
      </Row>

      <Row
        align="center"
        gap="sm"
        wrap
        // Opaque paper surface + hairline rule, not glass: DESIGN.md's
        // "Paper, Not Glass Rule" forbids translucency/blur on sticky chrome.
        // Matches the sticky table header's treatment (Table.tsx).
        className="bg-card px-4 py-2 shadow-[0_1px_0_var(--border)]"
      >
        <div className="relative min-w-[180px] flex-1 md:max-w-xs">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="h-8 pr-7 pl-8 text-sm" /* tight: input padding aligns text under absolutely-positioned search/clear icons */
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => onSearchChange("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground" /* tight: icon-button hit area */
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Type Filter */}
        <Row align="center" gap="sm">
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
                value === "all"
                  ? null
                  : (locationType.safeParse(value).data ?? null),
              )
            }
            className="h-8 w-[120px]"
            placeholder="All"
          />
        </Row>

        {/* Empty Filter */}
        <Row align="center" gap="sm">
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
                    entity="inventory"
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
              onEmptyFilterChange(
                emptyFilterSchema.safeParse(value ?? "all").data ?? "all",
              )
            }
            className="h-8 w-[120px]"
            placeholder="All"
          />
        </Row>

        {/* Hide Non-Matching Checkbox - only show when filters are active */}
        {hasActiveFilters && (
          <Row align="center" gap="sm">
            <Checkbox
              id={hideNonMatchingId}
              checked={hideNonMatching}
              onCheckedChange={(checked) =>
                onHideNonMatchingChange(checked === true)
              }
              className="size-4"
            />
            <Label
              htmlFor={hideNonMatchingId}
              className="cursor-pointer text-xs text-muted-foreground"
            >
              Hide non-matching
            </Label>
          </Row>
        )}

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
            className="h-8 px-2 text-xs text-muted-foreground"
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
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="size-3.5" />
          New Location
        </Button>
      </Row>
      <EntityEditDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        request={captureRequest("location")}
      />
    </div>
  );
}
