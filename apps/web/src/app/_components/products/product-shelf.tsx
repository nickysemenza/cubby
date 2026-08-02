import { isDisplayableImageFile } from "@cubby/schemas/image";
import type { ProductListItem } from "@cubby/schemas/product";
import { formatCurrency } from "~/lib/utils";
import { ShelfCard, ShelfEmpty, ShelfGrid } from "../data-table/shelf";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";

/**
 * Photo-first "shelf" view of products — image-led cards captioned with price
 * (falling back to category). The data table stays one toggle away.
 */
export function ProductShelf({
  items,
  isLoading,
  error,
  infiniteScroll,
}: {
  items: ProductListItem[];
  isLoading?: boolean;
  error?: unknown;
  infiniteScroll?: InfiniteScrollControls;
}) {
  return (
    <ShelfGrid
      items={items}
      isLoading={isLoading}
      error={error}
      infiniteScroll={infiniteScroll}
      emptyState={<ShelfEmpty entity="product" label="No products yet" />}
      renderCard={(product) => {
        const images = (product.images ?? []).filter(isDisplayableImageFile);
        const subtitle =
          product.pricing.effectivePrice != null
            ? formatCurrency(product.pricing.effectivePrice)
            : (product.category ?? undefined);
        return (
          <ShelfCard
            key={product.id}
            to="/products/$shortcode"
            params={{ shortcode: product.id }}
            image={images[0]?.url}
            extraCount={images.length - 1}
            title={product.name}
            subtitle={subtitle}
            entity="product"
          />
        );
      }}
    />
  );
}
