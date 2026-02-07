import type { InfLocation, LocationType } from "@cubby/schemas/location";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Calendar, LayoutGrid, List } from "lucide-react";
import { useMemo, useState } from "react";
import { CardThumbnail } from "~/components/entity/card-thumbnail";
import { EntityStat } from "~/components/entity/entity-stat";
import { MobileCard } from "~/components/entity/mobile-card";
import { GridContainer } from "~/components/layout/grid-container";
import { Button } from "~/components/ui/button";
import { useTRPC } from "~/trpc/react";
import type { InventoryItem } from "./calculate-inventory-valuation";
import { InventoryValuationSummary } from "./inventory-valuation-summary";
import { LocationTypeBadge } from "./LocationTypeBadge";
import { getLocationIcon, getLocationTypeGroup } from "./location-type-theme";

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
  const api = useTRPC();
  const [isGrouped, setIsGrouped] = useState(true);

  const locationIds = useMemo(
    () => locations.map((loc) => loc.id),
    [locations],
  );

  // Batch fetch all inventory items for valuation calculations
  const { data: allInventory } = useQuery(
    api.inventory.getByLocationIds.queryOptions({ locationIds }),
  );

  // Group inventory items by locationId client-side
  const inventoryByLocation = useMemo(() => {
    const map = new Map<string, InventoryItem[]>();
    if (!allInventory) return map;

    for (const item of allInventory) {
      const locationId = item.location.id;
      const items = map.get(locationId) ?? [];
      items.push(item);
      map.set(locationId, items);
    }
    return map;
  }, [allInventory]);

  // Flat list sorted by name
  const sortedLocations = useMemo(
    () => [...locations].sort((a, b) => a.name.localeCompare(b.name)),
    [locations],
  );

  // Group locations by type, then by group
  const groupedLocations = useMemo(() => {
    // First group by specific type
    const byType = new Map<LocationType, InfLocation[]>();
    for (const loc of locations) {
      const list = byType.get(loc.type) ?? [];
      list.push(loc);
      byType.set(loc.type, list);
    }

    // Then organize by group, preserving type sub-groups
    const result: Array<{
      group: string;
      types: Array<{ type: LocationType; locations: InfLocation[] }>;
    }> = [];

    for (const group of groupOrder) {
      const typesInGroup: Array<{
        type: LocationType;
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
        typesInGroup.sort((a, b) => a.type.localeCompare(b.type));
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
      inventoryItems={inventoryByLocation.get(location.id) ?? []}
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
              <LayoutGrid className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <List className="mr-1.5 h-3.5 w-3.5" />
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
                <div className="mb-3">
                  <LocationTypeBadge type={type} />
                </div>
                <GridContainer cols="cards3">
                  {typeLocations.map((loc) => renderCard(loc, false))}
                </GridContainer>
              </div>
            ))}
          </div>
        ))
      ) : (
        /* Flat view */
        <GridContainer cols="cards3">
          {sortedLocations.map((loc) => renderCard(loc, canGroup))}
        </GridContainer>
      )}
    </div>
  );
}

interface LocationCardProps {
  location: InfLocation;
  showParentPath?: boolean;
  onLocationSelect?: (location: InfLocation) => void;
  inventoryItems: InventoryItem[];
  showTypeBadge?: boolean;
}

function LocationCard({
  location,
  showParentPath,
  onLocationSelect,
  inventoryItems,
  showTypeBadge = false,
}: LocationCardProps) {
  const childCount = location.childCount ?? 0;
  const inventoryCount = location.directItemCount ?? 0;
  const hasInventory = inventoryCount > 0;

  // Create subtitle with parent path
  const subtitle =
    showParentPath && location.parent
      ? `in ${location.parent.name}`
      : undefined;

  return (
    <MobileCard
      title={location.name}
      titleIcon={getLocationIcon(location.type)}
      subtitle={subtitle}
      imageSlot={
        location.images.length > 0 ? (
          <CardThumbnail
            images={location.images}
            alt={location.name}
            to="/locations/$id"
            params={{ id: location.id }}
          />
        ) : null
      }
      onClick={onLocationSelect ? () => onLocationSelect(location) : undefined}
      className="h-full transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
      detailsHref={`/locations/${location.id}`}
    >
      {/* Valuation row */}
      {hasInventory && (
        <div className="text-muted-foreground text-xs">
          <InventoryValuationSummary
            items={inventoryItems}
            variant="compact"
            hidePricingStatus
          />
        </div>
      )}

      {/* Stats row: counts */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        {showTypeBadge && <LocationTypeBadge type={location.type} />}
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
          count={inventoryCount}
          tooltip={
            inventoryCount === 1
              ? "1 inventory item"
              : `${inventoryCount} inventory items`
          }
        />
      </div>

      {/* Timestamp - subtle, at bottom */}
      {location.lastBulkInventory && (
        <div className="flex items-center gap-1 text-muted-foreground/70 text-xs">
          <Calendar size={12} />
          <span>
            {formatDistanceToNow(location.lastBulkInventory, {
              addSuffix: true,
            })}
          </span>
        </div>
      )}
    </MobileCard>
  );
}
