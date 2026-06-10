import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import type { z } from "zod";
import { formatCurrency } from "~/lib/utils";
import { ShelfCard, ShelfEmpty, ShelfGrid } from "../data-table/shelf";
import type { InfiniteScrollControls } from "../hooks/useInfiniteTableList";

type InventoryItem = z.infer<typeof inventoryWithLocationAndProductOut>;

/**
 * Photo-first "shelf" view of inventory items — image-led cards captioned with
 * the on-hand amount and value. The editable table stays one toggle away.
 */
export function InventoryShelf({
  items,
  isLoading,
  error,
  infiniteScroll,
}: {
  items: InventoryItem[];
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
      emptyState={<ShelfEmpty entity="inventory" label="Nothing here yet" />}
      renderCard={(item) => {
        const images = item.product.images ?? [];
        return (
          <ShelfCard
            key={item.id}
            to="/products/$id"
            params={{ id: item.product.id }}
            image={images[0]?.url}
            extraCount={images.length - 1}
            title={item.product.name}
            subtitle={`${item.amount.value} ${item.amount.unit}${
              item.valuation != null
                ? ` · ${formatCurrency(item.valuation)}`
                : ""
            }`}
            entity="inventory"
          />
        );
      }}
    />
  );
}
