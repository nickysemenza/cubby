"use client";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { type InfLocation } from "~/schemas/location";
import { LocationIcon } from "./location-icons";
import { cn } from "~/lib/utils";
import Link from "next/link";
import { useTRPC } from "~/trpc/react";
import { useQuery } from "@tanstack/react-query";
import { Package, MapPin, Calendar, ArrowRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ProductPillLink } from "../EntityPill";

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

  return (
    <Link href={`/locations/${location.id}`}>
      <Card className="group h-full cursor-pointer transition-shadow hover:shadow-md">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <LocationIcon
              type={location.type}
              className="text-primary transition-transform group-hover:scale-110"
              size={18}
            />
            <span className="truncate">{location.name}</span>
          </CardTitle>

          {/* Parent Path */}
          {showParentPath && location.parent && (
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
              <MapPin size={12} />
              <span className="truncate">in {location.parent.name}</span>
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-3">
          {/* Stats Row */}
          <div className="flex items-center gap-3 text-sm">
            {hasChildren && (
              <div className="flex items-center gap-1">
                <LocationIcon
                  type={location.type}
                  size={12}
                  className="text-muted-foreground"
                />
                <span className="text-muted-foreground">{childrenCount}</span>
              </div>
            )}
            {hasInventory && (
              <div className="flex items-center gap-1">
                <Package size={12} className="text-muted-foreground" />
                <span className="text-muted-foreground">{inventoryCount}</span>
              </div>
            )}
          </div>

          {/* Location Type */}
          <Badge variant="outline" className="text-xs">
            {location.type}
          </Badge>

          {/* Recent Inventory Preview */}
          {hasInventory && inventoryData?.items && (
            <div className="space-y-1">
              <div className="text-muted-foreground text-xs font-medium">
                Recent items:
              </div>
              <div className="space-y-1">
                {inventoryData.items.slice(0, 2).map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-1 text-xs"
                  >
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
            </div>
          )}

          {/* Children Preview */}
          {hasChildren && location.children && (
            <div className="space-y-1">
              <div className="text-muted-foreground text-xs font-medium">
                Contains:
              </div>
              <div className="flex flex-wrap gap-1">
                {location.children.slice(0, 3).map((child) => (
                  <Badge key={child.id} variant="secondary" className="text-xs">
                    <LocationIcon
                      type={child.type}
                      size={10}
                      className="mr-1"
                    />
                    {child.name}
                  </Badge>
                ))}
                {childrenCount > 3 && (
                  <Badge variant="secondary" className="text-xs">
                    +{childrenCount - 3}
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* Last Updated */}
          {location.lastBulkInventory && (
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
              <Calendar size={10} />
              <span>
                Updated{" "}
                {formatDistanceToNow(location.lastBulkInventory, {
                  addSuffix: true,
                })}
              </span>
            </div>
          )}

          {/* Action Indicator */}
          <div className="flex justify-end">
            <ArrowRight
              size={14}
              className="text-muted-foreground transition-transform group-hover:translate-x-1"
            />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
