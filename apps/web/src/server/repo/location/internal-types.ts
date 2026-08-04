/**
 * Internal type definitions for location repository.
 * Types used across location modules.
 */

import type { InventoryItemForTree } from "@cubby/schemas/location";
import type { inventoryEntry, location, product } from "~/server/db/schema";
import type {
  MappableImageRecord,
  RowWithOptionalAliases,
} from "~/server/repo/database-helpers";

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
    image: MappableImageRecord;
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
    image: MappableImageRecord;
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
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  nameFilter?: string;
  itemTypeFilter?: string | string[];
  parentId?: string | string[];
  parentPresenceFilter?: "has" | "none";
  // The inventory column's "(none)" / "Has inventory" sentinel — "none" is the
  // empty-shelf worklist. Counts only entries whose product is itself live.
  inventoryPresenceFilter?: "has" | "none";
  // The image column's "(none)" / "Has image" sentinel. Counts only displayable
  // images, matching the thumbnail cell — PDF attachments don't count.
  imagePresenceFilter?: "has" | "none";
  directItemCountMin?: number;
  directItemCountMax?: number;
  valuationMin?: number;
  valuationMax?: number;
}
