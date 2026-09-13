import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { Link } from "@tanstack/react-router";
import { type Ref, useMemo } from "react";

import { Row } from "~/components/layout";
import { ImageWithPreview } from "~/components/ui/image-with-preview";
import { EntityIcon } from "~/entities/entities";
import { cn, formatCurrency } from "~/lib/utils";

import { useHydratedProductImages } from "../products/product-image-summaries";
import { LocationIcon } from "./location-icons";
import { LocationVisual } from "./location-visual";
import { locationChildGroupLabel } from "./location-visual-resolver";

type ProductPreview = {
  id: string;
  name: string;
};

interface LocationGalleryCardProps {
  location: InfLocation;
  inventoryItems: InventoryItemForTree[];
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
      const existing = productMap.get(item.productId);
      if (existing) {
        continue;
      }
      productMap.set(item.productId, {
        id: item.productId,
        name: item.productName,
      });
    }

    return Array.from(productMap.values());
  }, [inventoryItems]);

  const extraLocationImages = location.images.slice(1, 4);
  const childCount = location.children?.length ?? location.childCount ?? 0;
  const totalItemCount =
    location.valuation?.totalItemCount ?? location.totalItemCount ?? 0;
  const childLabel = locationChildGroupLabel(location.children ?? []);

  return (
    <div
      ref={ref}
      data-location-id={location.id}
      className={cn(
        "group border border-[var(--border)] bg-card transition-all duration-300",
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
          <LocationVisual
            location={location}
            variant="card"
            className="size-20 shrink-0"
            interactive
          />
          <div className="min-w-0 flex-1">
            <Row align="center" gap="xs" wrap className="min-w-0">
              <LocationIcon
                type={location.type}
                product={location.product}
                colored
                className="size-3.5 shrink-0"
              />
              <Link
                to="/locations/$shortcode"
                params={{ shortcode: location.id }}
                className="min-w-0 truncate text-xs font-medium hover:text-primary hover:underline"
                title={location.name}
              >
                {location.name}
              </Link>
              {totalItemCount > 0 && (
                <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
                  {formatCurrency(location.valuation?.totalValuation ?? 0)}
                </span>
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
                  to="/images/$shortcode"
                  params={{ shortcode: image.id }}
                  size={28}
                />
              ))}
            </Row>
          )}
        </Row>
      </div>

      <div className="p-2">
        {productImages.length > 0 ? (
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {productImages.map((product) => (
              <Row key={product.id} align="center" gap="sm">
                <ProductPreviewImage product={product} />
                <Link
                  to="/products/$shortcode"
                  params={{ shortcode: product.id }}
                  className="line-clamp-2 flex-1 text-2xs leading-tight hover:text-primary"
                  title={product.name}
                >
                  {product.name}
                </Link>
              </Row>
            ))}
          </div>
        ) : totalItemCount > 0 || childCount > 0 ? (
          <Row
            align="center"
            justify="center"
            gap="sm"
            className="py-2 text-2xs text-muted-foreground"
          >
            <EntityIcon entity="location" className="size-3 opacity-40" />
            <span>
              {totalItemCount} {totalItemCount === 1 ? "item" : "items"}
              {childCount > 0
                ? ` across ${childCount} ${childLabel.toLowerCase()}`
                : ""}
            </span>
          </Row>
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
        params={{ shortcode: product.id }}
        size={32}
      />
    );
  }

  return (
    <Link
      to="/products/$shortcode"
      params={{ shortcode: product.id }}
      className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/50"
    >
      <EntityIcon
        entity="product"
        className="size-3 text-muted-foreground/40"
      />
    </Link>
  );
}
