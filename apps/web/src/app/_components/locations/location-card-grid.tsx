import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { Calendar, LayoutGrid, List } from "lucide-react";
import { useMemo, useState } from "react";
import { AuditedHint } from "~/app/inventory/session/_components/AuditedHint";
import { EntityStat } from "~/components/entity/entity-stat";
import { MobileCard } from "~/components/entity/mobile-card";
import { Grid } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { entities, entityDetailParams } from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";
import { LocationTypeLabel } from "./LocationTypeLabel";
import { getLocationGlyph, getLocationTypeGroup } from "./location-type-theme";
import { LocationVisual } from "./location-visual";

interface LocationCardGridProps {
  locations: InfLocation[];
  className?: string;
  showParentPath?: boolean;
  onLocationSelect?: (location: InfLocation) => void;
}

/** Order for displaying type groups */
const groupOrder = ["surfaces", "storage", "containers", "spaces"] as const;

export function LocationCardGrid({
  locations,
  className,
  showParentPath = false,
  onLocationSelect,
}: LocationCardGridProps) {
  const [isGrouped, setIsGrouped] = useState(true);

  // Flat list sorted by name
  const sortedLocations = useMemo(
    () => [...locations].sort((a, b) => a.name.localeCompare(b.name)),
    [locations],
  );

  // Group locations by type, then by group
  const groupedLocations = useMemo(() => {
    // First group by specific type
    // Null keys the product-backed locations into a single bucket — they have
    // no form factor of their own, so there is nothing finer to group them by.
    const byType = new Map<LocationType | null, InfLocation[]>();
    for (const loc of locations) {
      const list = byType.get(loc.type) ?? [];
      list.push(loc);
      byType.set(loc.type, list);
    }

    // Then organize by group, preserving type sub-groups
    const result: Array<{
      group: string;
      types: Array<{ type: LocationType | null; locations: InfLocation[] }>;
    }> = [];

    for (const group of groupOrder) {
      const typesInGroup: Array<{
        type: LocationType | null;
        locations: InfLocation[];
      }> = [];
      for (const [type, locs] of byType) {
        if (getLocationTypeGroup(type) === group) {
          // Sort locations within each type by name
          locs.sort((a, b) => a.name.localeCompare(b.name));
          typesInGroup.push({ type, locations: locs });
        }
      }
      if (typesInGroup.length > 0) {
        // Sort types alphabetically within group
        typesInGroup.sort((a, b) =>
          (a.type ?? "\uffff").localeCompare(b.type ?? "\uffff"),
        );
        result.push({ group, types: typesInGroup });
      }
    }

    return result;
  }, [locations]);

  // Check if grouping makes sense (more than one type)
  const totalTypes = groupedLocations.reduce(
    (sum, g) => sum + g.types.length,
    0,
  );
  const canGroup = totalTypes > 1;

  // Helper to render a single card
  const renderCard = (location: InfLocation, showBadge: boolean) => (
    <LocationCard
      key={location.id}
      location={location}
      showParentPath={showParentPath}
      onLocationSelect={onLocationSelect}
      showTypeBadge={showBadge}
    />
  );

  return (
    <div className={className}>
      {/* Toggle - only show if there are multiple types */}
      {canGroup && (
        <div className="mb-4 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsGrouped(!isGrouped)}
            aria-label="Toggle grouping by type"
          >
            {isGrouped ? (
              <LayoutGrid className="mr-1.5 size-3.5" /* tight: icon+label */ />
            ) : (
              <List className="mr-1.5 size-3.5" /* tight: icon+label */ />
            )}
            <span className="text-xs">{isGrouped ? "Grouped" : "All"}</span>
          </Button>
        </div>
      )}

      {/* Grouped view */}
      {isGrouped && canGroup ? (
        groupedLocations.map(({ group, types }) => (
          <div key={group}>
            {types.map(({ type, locations: typeLocations }) => (
              <div key={type} className="mb-6 last:mb-0">
                <div className="mb-4">
                  <LocationTypeLabel type={type} product={null} />
                </div>
                <Grid cols="cards3">
                  {typeLocations.map((loc) => renderCard(loc, false))}
                </Grid>
              </div>
            ))}
          </div>
        ))
      ) : (
        /* Flat view */
        <Grid cols="cards3">
          {sortedLocations.map((loc) => renderCard(loc, canGroup))}
        </Grid>
      )}
    </div>
  );
}

interface LocationCardProps {
  location: InfLocation;
  showParentPath?: boolean;
  onLocationSelect?: (location: InfLocation) => void;
  showTypeBadge?: boolean;
}

function LocationCard({
  location,
  showParentPath,
  onLocationSelect,
  showTypeBadge = false,
}: LocationCardProps) {
  const childCount = location.childCount ?? 0;
  const inventoryCount = location.directItemCount ?? 0;
  const totalInventoryCount =
    location.valuation?.totalItemCount ??
    location.totalItemCount ??
    inventoryCount;
  const hasInventory = totalInventoryCount > 0;

  // Create subtitle with parent path
  const subtitle =
    showParentPath && location.parent
      ? `in ${location.parent.name}`
      : undefined;

  return (
    <MobileCard
      title={location.name}
      titleIcon={getLocationGlyph(location)}
      subtitle={subtitle}
      imageSlot={
        <LocationVisual location={location} variant="compact" size={48} />
      }
      onClick={onLocationSelect ? () => onLocationSelect(location) : undefined}
      className="h-full"
      detailsHref={entities.location.routes.detail.replace(
        "$shortcode",
        entityDetailParams(location.id).shortcode,
      )}
    >
      {/* Valuation row */}
      {hasInventory && location.valuation && (
        <div className="font-mono text-2xs text-muted-foreground tabular-nums">
          {formatCurrency(location.valuation.totalValuation)}
        </div>
      )}

      {/* Stats row: counts */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
        {showTypeBadge && (
          <LocationTypeLabel type={location.type} product={location.product} />
        )}
        <EntityStat
          entity="location"
          count={childCount}
          tooltip={
            childCount === 1
              ? "1 child location"
              : `${childCount} child locations`
          }
        />
        <EntityStat
          entity="inventory"
          count={totalInventoryCount}
          tooltip={
            totalInventoryCount === 1
              ? "1 inventory item"
              : `${totalInventoryCount} inventory items across this location and its children`
          }
        />
      </div>

      {/* Last recount - subtle, at bottom. AuditedHint (not a raw relative
          timestamp) so every recount-recency surface reads the same and tints
          warning once the bin goes stale. */}
      <div className="flex items-center gap-1 font-mono text-2xs">
        <Calendar size={12} className="text-muted-foreground" />
        <AuditedHint at={location.lastBulkInventory} label="recounted" />
      </div>
    </MobileCard>
  );
}
