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
  children: Array<typeof location.$inferSelect>;
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

/**
 * Input data for location import updates.
 * Matches location sync fields for consistency.
 */
export interface LocationImportData {
  lastInventoryDate?: Date | null;
  description?: string | null;
  locationType?: import("~/schemas/location").LocationType;
  parentId?: import("~/schemas/identifiers").LocationId | null;
}
