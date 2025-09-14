"use client";
import { Badge } from "~/components/ui/badge";
import { type InfLocation } from "~/schemas/location";
import { getLocationIcon } from "./location-icons";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import { Package, Calendar, ExternalLink } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ProductPillLink } from "../EntityPill";
import { InventoryValueSummary } from "./inventory-value-summary";
import { EntityPreviewCard } from "~/components/ui/entity-preview-card";

interface LocationCardGridProps {
  locations: InfLocation[];
  className?: string;
  showParentPath?: boolean;
}

export function LocationCardGrid({
  locations,
  className,
  showParentPath = false,
}: LocationCardGridProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
        className,
      )}
    >
      {locations.map((location) => (
        <LocationCard
          key={location.id}
          location={location}
          showParentPath={showParentPath}
        />
      ))}
    </div>
  );
}

interface LocationCardProps {
  location: InfLocation;
  showParentPath?: boolean;
}

function LocationCard({ location, showParentPath }: LocationCardProps) {
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
    const ChildrenIcon = getLocationIcon(location.type);
    badges.push(
      <div key="children" className="flex items-center gap-1 text-xs">
        <ChildrenIcon size={10} className="text-muted-foreground" />
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
        <div className="text-muted-foreground text-xs font-medium">
          Recent items:
        </div>
        <div className="space-y-1">
          {inventoryData.items.slice(0, 2).map((item) => (
            <div key={item.id} className="flex items-center gap-1 text-xs">
              <div className="bg-primary h-1 w-1 rounded-full" />
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
        <div className="text-muted-foreground text-xs font-medium">
          Contains:
        </div>
        <div className="flex flex-wrap gap-1">
          {location.children.slice(0, 3).map((child) => {
            const ChildIcon = getLocationIcon(child.type);
            return (
              <Badge key={child.id} variant="secondary" className="text-xs">
                <ChildIcon size={10} className="mr-1" />
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
    <div className="text-muted-foreground flex items-center gap-1 text-xs">
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
      className="h-full transition-shadow hover:shadow-md"
    />
  );
}
