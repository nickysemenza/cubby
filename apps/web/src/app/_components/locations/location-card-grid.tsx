import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Calendar } from "lucide-react";
import { MobileCard } from "~/components/entity/mobile-card";
import { GridContainer } from "~/components/layout/grid-container";
import { Badge } from "~/components/ui/badge";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";
import type { InfLocation } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
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
  return (
    <GridContainer cols="cards3" className={cn("stagger-children", className)}>
      {locations.map((location) => (
        <LocationCard
          key={location.id}
          location={location}
          showParentPath={showParentPath}
          onLocationSelect={onLocationSelect}
        />
      ))}
    </GridContainer>
  );
}

interface LocationCardProps {
  location: InfLocation;
  showParentPath?: boolean;
  onLocationSelect?: (location: InfLocation) => void;
}

function LocationCard({
  location,
  showParentPath,
  onLocationSelect,
}: LocationCardProps) {
  const api = useTRPC();

  // Get inventory items for this location
  const { data: inventoryData } = useQuery(
    api.inventory.list.queryOptions({
      sort: { orderBy: "createdAt", direction: "desc" },
      pagination: { pageIndex: 0, pageSize: 5 }, // Just get first few for preview
      filters: { locationIdFilter: location.id },
    }),
  );

  const childrenCount = location.children?.length || 0;
  const inventoryCount = inventoryData?.meta?.totalCount || 0;
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
        locationId={location.id}
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
