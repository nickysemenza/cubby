import { Link } from "@tanstack/react-router";
import { Package } from "lucide-react";
import { forwardRef, useMemo } from "react";
import type { z } from "zod";
import { Badge } from "~/components/ui/badge";
import { ImageWithPreview } from "~/components/ui/image-with-preview";
import { cn } from "~/lib/utils";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import type { InfLocation } from "~/schemas/location";
import { InventoryValueSummary } from "./inventory-value-summary";
import { LocationIcon } from "./location-icons";

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
        "group rounded-lg border bg-card transition-all duration-300",
        // Highlight state for search matches
        isHighlighted && "ring-2 ring-primary/50 ring-offset-2",
        // Faded state for non-matches
        isFaded && "opacity-40",
        // Hover effects
        !isFaded && "hover:shadow-md hover:shadow-primary/5",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <LocationIcon
          type={location.type}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
        <Link
          to="/locations/$id"
          params={{ id: location.id }}
          className="flex-1 truncate font-medium text-xs hover:text-primary hover:underline"
        >
          {location.name}
        </Link>
        {inventoryItems.length > 0 && (
          <InventoryValueSummary items={inventoryItems} variant="compact" />
        )}
        <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">
          {location.type}
        </Badge>
      </div>

      {/* Location Images Strip */}
      {hasLocationImages && (
        <div className="flex gap-1 overflow-x-auto border-b bg-muted/20 p-1.5">
          {location.images.map((image) => (
            <ImageWithPreview
              key={image.id}
              src={image.url}
              alt={`${location.name} photo`}
              to="/images/$id"
              params={{ id: image.id }}
              size={40}
              previewSize={240}
            />
          ))}
        </div>
      )}

      {/* Products Section */}
      <div className="p-1.5">
        {productImages.length > 0 ? (
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {productImages.map((product) => (
              <div key={product.id} className="flex items-center gap-1.5">
                {product.images[0] ? (
                  <ImageWithPreview
                    src={product.images[0].url}
                    alt={product.name}
                    to="/products/$id"
                    params={{ id: product.id }}
                    size={32}
                    previewSize={200}
                  />
                ) : (
                  <Link
                    to="/products/$id"
                    params={{ id: product.id }}
                    className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/50"
                  >
                    <Package className="h-3 w-3 text-muted-foreground/40" />
                  </Link>
                )}
                <Link
                  to="/products/$id"
                  params={{ id: product.id }}
                  className="line-clamp-2 flex-1 text-[10px] leading-tight hover:text-primary"
                >
                  {product.name}
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-1.5 py-2 text-[10px] text-muted-foreground">
            <Package className="h-3 w-3 opacity-40" />
            <span>Empty</span>
          </div>
        )}
      </div>
    </div>
  );
});
