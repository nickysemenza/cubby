import type { inventoryListItemOut } from "@cubby/schemas/inventory";
import type { InfLocation } from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import { type Ref, useMemo } from "react";
import type { z } from "zod";
import { Row } from "~/components/layout";
import { ImageWithPreview } from "~/components/ui/image-with-preview";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";
import { useHydratedProductImages } from "../products/product-image-summaries";
import { InventoryValuationSummary } from "./inventory-valuation-summary";
import { LocationIcon } from "./location-icons";

type InventoryItem = z.infer<typeof inventoryListItemOut>;
type ProductPreview = {
  id: string;
  shortcode: string;
  name: string;
  totalAmount: string;
};

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
    const productMap = new Map<string, ProductPreview>();

    for (const item of inventoryItems) {
      const existing = productMap.get(item.product.id);
      if (existing) {
        // Aggregate amounts (simplified - just show count)
        continue;
      }
      productMap.set(item.product.id, {
        id: item.product.id,
        shortcode: item.product.shortcode,
        name: item.product.name,
        totalAmount: `${item.amount.value} ${item.amount.unit}`,
      });
    }

    return Array.from(productMap.values());
  }, [inventoryItems]);

  const primaryLocationImage = location.images[0];
  const extraLocationImages = location.images.slice(1, 4);

  return (
    <div
      ref={ref}
      data-location-id={location.id}
      className={cn(
        "group rounded-xl border border-[var(--border)] bg-card transition-all duration-300",
        // Highlight state for search matches
        isHighlighted && "ring-2 ring-primary/50 ring-offset-2",
        // Faded state for non-matches
        isFaded && "opacity-40",
        // Hover effects
        !isFaded && "hover:ring-1 hover:ring-primary/40",
        className,
      )}
    >
      <div className="border-b px-2 py-2">
        <Row align="center" gap="sm" className="min-w-0">
          {primaryLocationImage ? (
            <ImageWithPreview
              src={primaryLocationImage.url}
              alt={`${location.name} photo`}
              to="/images/$id"
              params={{ id: primaryLocationImage.id }}
              size={40}
              previewSize={240}
            />
          ) : (
            <div className="flex size-10 shrink-0 items-center justify-center border bg-muted/40">
              <LocationIcon type={location.type} colored size={18} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <Row align="center" gap="xs" wrap className="min-w-0">
              <LocationIcon
                type={location.type}
                colored
                className="size-3.5 shrink-0"
              />
              <Link
                to="/locations/$shortcode"
                params={{ shortcode: location.shortcode }}
                className="min-w-0 truncate font-medium text-xs hover:text-primary hover:underline"
                title={location.name}
              >
                {location.name}
              </Link>
              {inventoryItems.length > 0 && (
                <InventoryValuationSummary
                  items={inventoryItems}
                  variant="compact"
                  hidePricingStatus
                  className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums"
                />
              )}
            </Row>
          </div>
          {extraLocationImages.length > 0 && (
            <Row gap="xs" className="hidden shrink-0 sm:flex">
              {extraLocationImages.map((image) => (
                <ImageWithPreview
                  key={image.id}
                  src={image.url}
                  alt={`${location.name} photo`}
                  to="/images/$id"
                  params={{ id: image.id }}
                  size={28}
                  previewSize={240}
                />
              ))}
            </Row>
          )}
        </Row>
      </div>

      {/* Products Section */}
      <div className="p-2">
        {productImages.length > 0 ? (
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {productImages.map((product) => (
              <Row key={product.id} align="center" gap="sm">
                <ProductPreviewImage product={product} />
                <Link
                  to="/products/$shortcode"
                  params={{ shortcode: product.shortcode }}
                  className="line-clamp-2 flex-1 text-2xs leading-tight hover:text-primary"
                  title={product.name}
                >
                  {product.name}
                </Link>
              </Row>
            ))}
          </div>
        ) : (
          <Row
            align="center"
            justify="center"
            gap="sm"
            className="py-2 text-2xs text-muted-foreground"
          >
            <EntityIcon entity="inventory" className="size-3 opacity-40" />
            <span>Empty</span>
          </Row>
        )}
      </div>
    </div>
  );
};

function ProductPreviewImage({ product }: { product: ProductPreview }) {
  const images = useHydratedProductImages(product.id);
  const image = images[0];

  if (image) {
    return (
      <ImageWithPreview
        src={image.url}
        alt={product.name}
        to="/products/$shortcode"
        params={{ shortcode: product.shortcode }}
        size={32}
        previewSize={200}
      />
    );
  }

  return (
    <Link
      to="/products/$shortcode"
      params={{ shortcode: product.shortcode }}
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/50"
    >
      <EntityIcon
        entity="product"
        className="size-3 text-muted-foreground/40"
      />
    </Link>
  );
}
