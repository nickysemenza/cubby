import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Calendar } from "lucide-react";
import { useMemo } from "react";
import { MobileCard } from "~/components/entity/mobile-card";
import { GridContainer } from "~/components/layout/grid-container";
import { Badge } from "~/components/ui/badge";
import { EntityIcon } from "~/entities/entities";
import type { InfLocation } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import type { InventoryItem } from "./calculate-inventory-valuation";
import { InventoryValuationSummary } from "./inventory-valuation-summary";
import { LocationTypeBadge } from "./LocationTypeBadge";
import { LocationIcon } from "./location-icons";
import { getLocationIcon } from "./location-type-theme";

interface LocationCardGridProps {
  locations: InfLocation[];
  className?: string;
  showParentPath?: boolean;
  onLocationSelect?: (location: InfLocation) => void;
}

export function LocationCardGrid({
  locations,
  className,
  showParentPath = false,
  onLocationSelect,
}: LocationCardGridProps) {
  const api = useTRPC();

  // Batch query inventory counts and items for all locations (avoid N+1)
  const locationIds = useMemo(
    () => locations.map((loc) => loc.id),
    [locations],
  );

  const { data: inventoryCounts } = useQuery(
    api.inventory.getCountsByLocations.queryOptions({ locationIds }),
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
      const items = map.get(item.locationId) ?? [];
      items.push(item);
      map.set(item.locationId, items);
    }
    return map;
  }, [allInventory]);

  return (
    <GridContainer cols="cards3" className={className}>
      {locations.map((location) => (
        <LocationCard
          key={location.id}
          location={location}
          showParentPath={showParentPath}
          onLocationSelect={onLocationSelect}
          inventoryCount={inventoryCounts?.[location.id] ?? 0}
          inventoryItems={inventoryByLocation.get(location.id) ?? []}
        />
      ))}
    </GridContainer>
  );
}

interface LocationCardProps {
  location: InfLocation;
  showParentPath?: boolean;
  onLocationSelect?: (location: InfLocation) => void;
  inventoryCount: number;
  inventoryItems: InventoryItem[];
}

function LocationCard({
  location,
  showParentPath,
  onLocationSelect,
  inventoryCount,
  inventoryItems,
}: LocationCardProps) {
  const childrenCount = location.children?.length || 0;
  const hasInventory = inventoryCount > 0;
  const hasChildren = childrenCount > 0;

  // Create subtitle with parent path
  const subtitle =
    showParentPath && location.parent
      ? `in ${location.parent.name}`
      : undefined;

  // Create badges
  const badges = [<LocationTypeBadge key="type" type={location.type} />];

  // Add stats badges
  if (hasChildren) {
    badges.push(
      <div key="children" className="flex items-center gap-1 text-xs">
        <LocationIcon
          type={location.type}
          size={10}
          className="text-muted-foreground"
        />
        <span className="text-muted-foreground">{childrenCount}</span>
      </div>,
    );
  }

  if (hasInventory) {
    badges.push(
      <div key="inventory" className="flex items-center gap-1 text-xs">
        <EntityIcon
          entity="inventory"
          size={10}
          className="text-muted-foreground"
        />
        <span className="text-muted-foreground">{inventoryCount}</span>
      </div>,
    );
  }

  // Create details
  const details = [];

  // Inventory value
  if (hasInventory) {
    details.push(
      <InventoryValuationSummary
        key="value"
        items={inventoryItems}
        variant="compact"
        className=""
      />,
    );
  }

  // Children preview
  if (hasChildren && location.children) {
    details.push(
      <div key="children-preview" className="space-y-1">
        <div className="font-medium text-muted-foreground text-xs">
          Contains:
        </div>
        <div className="flex flex-wrap gap-1">
          {location.children.slice(0, 3).map((child) => {
            return (
              <Badge
                key={child.id}
                variant="secondary"
                className="max-w-[120px] text-xs"
              >
                <LocationIcon
                  type={child.type}
                  size={10}
                  className="mr-1 shrink-0"
                />
                <span className="truncate">{child.name}</span>
              </Badge>
            );
          })}
          {childrenCount > 3 && (
            <Badge variant="secondary" className="text-xs">
              +{childrenCount - 3}
            </Badge>
          )}
        </div>
      </div>,
    );
  }

  return (
    <MobileCard
      title={location.name}
      titleIcon={getLocationIcon(location.type)}
      subtitle={subtitle}
      onClick={onLocationSelect ? () => onLocationSelect(location) : undefined}
      className="h-full transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
      detailsHref={`/locations/${location.id}`}
    >
      {/* Details */}
      {details.length > 0 && <div className="space-y-1">{details}</div>}

      {/* Badges */}
      {badges.length > 0 && (
        <div className="flex flex-wrap gap-2">{badges}</div>
      )}

      {/* Footer with timestamp */}
      {location.lastBulkInventory && (
        <div className="flex items-center gap-1 border-t pt-2 text-muted-foreground text-xs">
          <Calendar size={10} />
          <span>
            Updated{" "}
            {formatDistanceToNow(location.lastBulkInventory, {
              addSuffix: true,
            })}
          </span>
        </div>
      )}
    </MobileCard>
  );
}
