/**
 * Internal type definitions for location repository.
 * Types used across location modules.
 */

import type { InventoryItemForTree } from "@cubby/schemas/location";
import type {
  image,
  inventoryEntry,
  location,
  product,
} from "~/server/db/schema";
import type { RowWithOptionalAliases } from "~/server/repo/database-helpers";

type LocationSelect = RowWithOptionalAliases<typeof location.$inferSelect>;
type ProductSelect = RowWithOptionalAliases<typeof product.$inferSelect>;

export type LocationListDB = LocationSelect & {
  parent: LocationSelect | null;
  children: Array<LocationSelect>;
  inventoryEntries: Array<
    typeof inventoryEntry.$inferSelect & {
      product: ProductSelect;
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
export type LocationWithParentChild = LocationSelect & {
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
  itemTypeFilter?: string | string[];
  parentPresenceFilter?: "has" | "none";
}
