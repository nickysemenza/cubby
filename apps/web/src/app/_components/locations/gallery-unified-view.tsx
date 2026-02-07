import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import type { InfLocation } from "@cubby/schemas/location";
import type { RefCallback } from "react";
import type { z } from "zod";
import { cn } from "~/lib/utils";
import { LocationGalleryCard } from "./location-gallery-card";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface GalleryUnifiedViewProps {
  locations: InfLocation[];
  inventoryByLocation: Map<string, InventoryItem[]>;
  searchTerm: string;
  searchMatchingIds: Set<string>;
  fadedIds: Set<string>;
  createLocationRef: (locationId: string) => RefCallback<HTMLDivElement>;
  className?: string;
}

// Background tints for each depth level
const depthBackgrounds = [
  "", // Level 0 - no tint
  "bg-muted/5",
  "bg-muted/10",
  "bg-muted/15",
  "bg-muted/20",
];

/**
 * Unified gallery view combining tree hierarchy with grid-like horizontal rows.
 * - Siblings at each level flow horizontally (flex-wrap)
 * - Indentation shows hierarchy depth
 * - Tree connector lines link parent to children row
 * - Subtle background tints reinforce depth
 * - Responsive: horizontal on desktop, stacked on mobile
 */
export function GalleryUnifiedView({
  locations,
  inventoryByLocation,
  searchTerm,
  searchMatchingIds,
  fadedIds,
  createLocationRef,
  className,
}: GalleryUnifiedViewProps) {
  return (
    <div className={cn("py-2", className)}>
      {/* Root level - no indentation */}
      <LocationRow
        locations={locations}
        level={0}
        inventoryByLocation={inventoryByLocation}
        searchTerm={searchTerm}
        searchMatchingIds={searchMatchingIds}
        fadedIds={fadedIds}
        createLocationRef={createLocationRef}
      />
    </div>
  );
}

interface LocationRowProps {
  locations: InfLocation[];
  level: number;
  inventoryByLocation: Map<string, InventoryItem[]>;
  searchTerm: string;
  searchMatchingIds: Set<string>;
  fadedIds: Set<string>;
  createLocationRef: (locationId: string) => RefCallback<HTMLDivElement>;
}

function LocationRow({
  locations,
  level,
  inventoryByLocation,
  searchTerm,
  searchMatchingIds,
  fadedIds,
  createLocationRef,
}: LocationRowProps) {
  const bgClass =
    depthBackgrounds[Math.min(level, depthBackgrounds.length - 1)];

  return (
    <div className="space-y-2">
      {locations.map((location) => {
        const inventoryItems = inventoryByLocation.get(location.id) ?? [];
        const isHighlighted = Boolean(
          searchTerm && searchMatchingIds.has(location.id),
        );
        const isFaded = fadedIds.has(location.id);
        const hasChildren = location.children && location.children.length > 0;

        return (
          <div key={location.id} className="relative">
            {/* Card with optional background tint */}
            <div className={cn("rounded-lg", bgClass && `${bgClass} p-2`)}>
              <LocationGalleryCard
                ref={createLocationRef(location.id)}
                location={location}
                inventoryItems={inventoryItems}
                isHighlighted={isHighlighted}
                isFaded={isFaded}
              />
            </div>

            {/* Children with tree lines */}
            {hasChildren && (
              <div className="relative mt-2 ml-6 pl-4">
                {/* Vertical line spanning all children */}
                <div className="absolute top-0 bottom-2 left-0 w-0.5 bg-muted-foreground/25" />

                {/* Render each child with horizontal connector */}
                <div className="space-y-2">
                  {location.children!.map((child) => (
                    <div key={child.id} className="relative">
                      {/* Horizontal connector from vertical line to card */}
                      <div className="absolute top-5 -left-4 h-0.5 w-4 bg-muted-foreground/25" />
                      <LocationRow
                        locations={[child]}
                        level={level + 1}
                        inventoryByLocation={inventoryByLocation}
                        searchTerm={searchTerm}
                        searchMatchingIds={searchMatchingIds}
                        fadedIds={fadedIds}
                        createLocationRef={createLocationRef}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
