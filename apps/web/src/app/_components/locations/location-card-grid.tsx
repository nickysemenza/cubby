"use client";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Calendar, ExternalLink, Package } from "lucide-react";
import { EntityPreviewCard } from "~/components/entity/entity-preview-card";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import type { InfLocation } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import { ProductPillLink } from "../EntityPill";
import { InventoryValueSummary } from "./inventory-value-summary";
import { getLocationIcon, LocationIcon } from "./location-icons";

interface LocationCardGridProps {
  locations: InfLocation[];
  className?: string;
  showParentPath?: boolean;
  onLocationSelect?: (location: InfLocation) => void;
  /** Max columns at largest breakpoint. Default is 4. */
  maxColumns?: 2 | 3 | 4;
}

const columnClasses = {
  2: "grid grid-cols-1 gap-4 md:grid-cols-2",
  3: "grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3",
  4: "grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
};

export function LocationCardGrid({
  locations,
  className,
  showParentPath = false,
  onLocationSelect,
  maxColumns = 4,
}: LocationCardGridProps) {
  return (
    <div
      className={cn(columnClasses[maxColumns], "stagger-children", className)}
    >
      {locations.map((location) => (
        <LocationCard
          key={location.id}
          location={location}
          showParentPath={showParentPath}
          onLocationSelect={onLocationSelect}
        />
      ))}
    </div>
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
    api.inventoryItem.list.queryOptions({
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
  const badges = [
    <Badge key="type" variant="outline" className="text-xs">
      {location.type}
    </Badge>,
  ];

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
        <Package size={10} className="text-muted-foreground" />
        <span className="text-muted-foreground">{inventoryCount}</span>
      </div>,
    );
  }

  // Create details
  const details = [];

  // Inventory value
  if (hasInventory) {
    details.push(
      <InventoryValueSummary
        key="value"
        locationId={location.id}
        variant="compact"
        className=""
      />,
    );
  }

  // Recent inventory preview
  if (hasInventory && inventoryData?.items) {
    details.push(
      <div key="recent-items" className="space-y-1">
        <div className="font-medium text-muted-foreground text-xs">
          Recent items:
        </div>
        <div className="space-y-1">
          {inventoryData.items.slice(0, 2).map((item) => (
            <div key={item.id} className="flex items-center gap-1 text-xs">
              <div className="h-1 w-1 rounded-full bg-primary" />
              <ProductPillLink product={item.product} />
            </div>
          ))}
          {inventoryCount > 2 && (
            <div className="text-muted-foreground text-xs">
              +{inventoryCount - 2} more items
            </div>
          )}
        </div>
      </div>,
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
              <Badge key={child.id} variant="secondary" className="text-xs">
                <LocationIcon type={child.type} size={10} className="mr-1" />
                {child.name}
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

  // Create footer with timestamp
  const footer = location.lastBulkInventory ? (
    <div className="flex items-center gap-1 text-muted-foreground text-xs">
      <Calendar size={10} />
      <span>
        Updated{" "}
        {formatDistanceToNow(location.lastBulkInventory, {
          addSuffix: true,
        })}
      </span>
    </div>
  ) : undefined;

  return (
    <EntityPreviewCard
      title={location.name}
      titleIcon={getLocationIcon(location.type)}
      subtitle={subtitle}
      badges={badges}
      details={details}
      footer={footer}
      primaryAction={{
        href: `/locations/${location.id}`,
        label: "View",
        icon: ExternalLink,
      }}
      onClick={onLocationSelect ? () => onLocationSelect(location) : undefined}
      className="card-hover h-full"
    />
  );
}
