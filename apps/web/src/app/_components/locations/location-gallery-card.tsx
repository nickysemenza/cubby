import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import type { InfLocation } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import { type Ref, useMemo } from "react";
import type { z } from "zod";
import { ImageWithPreview } from "~/components/ui/image-with-preview";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";
import { InventoryValuationSummary } from "./inventory-valuation-summary";
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
export const LocationGalleryCard = function LocationGalleryCard({
  location,
  inventoryItems,
  isHighlighted,
  isFaded,
  className,
  ref,
}: LocationGalleryCardProps & { ref?: Ref<HTMLDivElement> }) {
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
        "group rounded-xl border bg-card transition-all duration-300",
        // Highlight state for search matches
        isHighlighted && "ring-2 ring-primary/50 ring-offset-2",
        // Faded state for non-matches
        isFaded && "opacity-40",
        // Hover effects
        !isFaded && "hover:shadow-md hover:shadow-primary/5",
        className,
      )}
    >
      {/* Header — name owns its own line so it isn't crushed by the value;
          the colored type icon already conveys location type (no badge). */}
      <div className="border-b px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <LocationIcon
            type={location.type}
            colored
            className="h-3.5 w-3.5 shrink-0"
          />
          <Link
            to="/locations/$id"
            params={{ id: location.id }}
            className="min-w-0 flex-1 truncate font-medium text-xs hover:text-primary hover:underline"
          >
            {location.name}
          </Link>
        </div>
        {inventoryItems.length > 0 && (
          <div className="mt-0.5 flex justify-end">
            <InventoryValuationSummary
              items={inventoryItems}
              variant="compact"
            />
          </div>
        )}
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
                    <EntityIcon
                      entity="product"
                      className="h-3 w-3 text-muted-foreground/40"
                    />
                  </Link>
                )}
                <Link
                  to="/products/$id"
                  params={{ id: product.id }}
                  className="line-clamp-2 flex-1 text-2xs leading-tight hover:text-primary"
                >
                  {product.name}
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-1.5 py-2 text-2xs text-muted-foreground">
            <EntityIcon entity="inventory" className="h-3 w-3 opacity-40" />
            <span>Empty</span>
          </div>
        )}
      </div>
    </div>
  );
};
