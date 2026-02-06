/**
 * Internal type definitions for location repository.
 * Types used across location modules.
 */

import type { InventoryItemForTree } from "~/schemas/location";
import type {
  image,
  inventoryEntry,
  location,
  product,
} from "~/server/db/schema";

/**
 * Type for deeply nested location query results.
 * Used when fetching locations with full relations.
 */
export type LocationDeepDB = typeof location.$inferSelect & {
  parent: typeof location.$inferSelect | null;
  children: Array<
    typeof location.$inferSelect & {
      images: Array<{ image: typeof image.$inferSelect }>;
    }
  >;
  InventoryEntries: Array<
    typeof inventoryEntry.$inferSelect & {
      Product: typeof product.$inferSelect;
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
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
