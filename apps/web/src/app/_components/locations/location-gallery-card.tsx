"use client";

import { forwardRef, useMemo } from "react";
import Link from "next/link";
import Image from "next/image";
import { Package } from "lucide-react";
import { cn } from "~/lib/utils";
import { Badge } from "~/components/ui/badge";
import { type InfLocation } from "~/schemas/location";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { type z } from "zod";
import { LocationIcon } from "./location-icons";
import { InventoryValueSummary } from "./inventory-value-summary";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

interface LocationGalleryCardProps {
  location: InfLocation;
  inventoryItems: InventoryItem[];
  isHighlighted?: boolean;
  isFaded?: boolean;
  className?: string;
}

/**
 * Gallery card showing a location with all its images and inventory products.
 * Features:
 * - Location header with type icon and badges
 * - Horizontal strip of location images
 * - Grid of product images with names
 * - Inventory value summary
 */
export const LocationGalleryCard = forwardRef<
  HTMLDivElement,
  LocationGalleryCardProps
>(function LocationGalleryCard(
  { location, inventoryItems, isHighlighted, isFaded, className },
  ref,
) {
  // Group inventory items by product for display
  const productImages = useMemo(() => {
    const productMap = new Map<
      string,
      {
        id: string;
        name: string;
        images: Array<{ id: string; url: string }>;
        totalAmount: string;
      }
    >();

    for (const item of inventoryItems) {
      const existing = productMap.get(item.product.id);
      if (existing) {
        // Aggregate amounts (simplified - just show count)
        continue;
      }
      productMap.set(item.product.id, {
        id: item.product.id,
        name: item.product.name,
        images: item.product.images ?? [],
        totalAmount: `${item.amount.value} ${item.amount.unit}`,
      });
    }

    return Array.from(productMap.values());
  }, [inventoryItems]);

  const hasLocationImages = location.images.length > 0;

  return (
    <div
      ref={ref}
      data-location-id={location.id}
      className={cn(
        "group bg-card rounded-lg border transition-all duration-300",
        // Highlight state for search matches
        isHighlighted && "ring-primary/50 ring-2 ring-offset-2",
        // Faded state for non-matches
        isFaded && "opacity-40",
        // Hover effects
        !isFaded && "hover:shadow-primary/5 hover:shadow-md",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <LocationIcon
          type={location.type}
          className="text-muted-foreground h-3.5 w-3.5 flex-shrink-0"
        />
        <Link
          href={`/locations/${location.id}`}
          className="hover:text-primary flex-1 truncate text-xs font-medium hover:underline"
        >
          {location.name}
        </Link>
        <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">
          {location.type}
        </Badge>
        {(location.directItemCount ?? 0) > 0 && (
          <Badge variant="secondary" className="h-4 px-1 text-[9px]">
            {location.directItemCount}
          </Badge>
        )}
      </div>

      {/* Location Images Strip */}
      {hasLocationImages && (
        <div className="bg-muted/20 flex gap-1 overflow-x-auto border-b p-1.5">
          {location.images.map((image) => (
            <Link
              key={image.id}
              href={`/images/${image.id}`}
              className="group/img bg-background relative h-10 w-10 flex-shrink-0 overflow-hidden rounded border transition-transform hover:scale-105"
            >
              <Image
                src={image.url}
                alt={`${location.name} photo`}
                fill
                sizes="40px"
                className="object-cover"
              />
            </Link>
          ))}
        </div>
      )}

      {/* Products Section */}
      <div className="p-1.5">
        {productImages.length > 0 ? (
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {productImages.map((product) => (
              <Link
                key={product.id}
                href={`/products/${product.id}`}
                className="group/product hover:bg-muted flex items-center gap-1.5 rounded p-1 transition-colors"
                title={product.name}
              >
                <div className="bg-muted/50 relative h-8 w-8 flex-shrink-0 overflow-hidden rounded border">
                  {product.images[0] ? (
                    <Image
                      src={product.images[0].url}
                      alt={product.name}
                      fill
                      sizes="32px"
                      className="object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <Package className="text-muted-foreground/40 h-3 w-3" />
                    </div>
                  )}
                </div>
                <span className="line-clamp-2 flex-1 text-[10px] leading-tight">
                  {product.name}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground flex items-center justify-center gap-1.5 py-2 text-[10px]">
            <Package className="h-3 w-3 opacity-40" />
            <span>Empty</span>
          </div>
        )}
      </div>

      {/* Footer - Inventory Value */}
      {inventoryItems.length > 0 && (
        <div className="bg-muted/10 border-t px-2 py-1">
          <InventoryValueSummary items={inventoryItems} variant="compact" />
        </div>
      )}
    </div>
  );
});
