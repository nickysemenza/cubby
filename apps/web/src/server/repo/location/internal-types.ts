/**
 * Internal type definitions for location repository.
 * Types used across location modules.
 */

import type { InventoryItemForTree } from "@cubby/schemas/location-responses";
import type {
  image,
  inventoryEntry,
  location,
  product,
} from "~/server/db/schema";

export type LocationListDB = typeof location.$inferSelect & {
  parent: typeof location.$inferSelect | null;
  children: Array<typeof location.$inferSelect>;
  inventoryEntries: Array<
    typeof inventoryEntry.$inferSelect & {
      product: typeof product.$inferSelect;
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
    deletedAt?: Date | null;
  }>;
};

/**
 * Helper type for recursive location queries.
 * Supports building hierarchical location trees.
 */
export type LocationWithParentChild = typeof location.$inferSelect & {
  children?: LocationWithParentChild[];
  parent?: LocationWithParentChild | null;
  images?: Array<{
    image: typeof image.$inferSelect;
    deletedAt?: Date | null;
  }>;
  childCount?: number;
  directItemCount?: number;
  inventoryItems?: InventoryItemForTree[];
};

/**
 * Filters for location list queries.
 */
export interface LocationFilters {
  nameFilter?: string;
  itemTypeFilter?: string;
}
