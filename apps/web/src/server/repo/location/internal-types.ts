/**
 * Internal type definitions for location repository.
 * Types used across location modules.
 */

import type { InventoryItemForTree } from "@cubby/schemas/location";
import type { ProductCategorySummary } from "@cubby/schemas/product-category-fields";

import type { inventoryEntry, location, product } from "~/server/db/schema";
import type {
  MappableImageRecord,
  RowWithOptionalAliases,
  RowWithOptionalAliasesAndTags,
} from "~/server/repo/database-helpers";

type LocationSelect = RowWithOptionalAliasesAndTags<
  typeof location.$inferSelect
>;

import type { MappableProductExternalId } from "~/server/repo/product/external-id-types";

type ProductSelect = RowWithOptionalAliases<typeof product.$inferSelect>;

/**
 * The identity product joined onto a location — the SKU the location IS.
 * Only the columns the wire shape needs, plus the cover image.
 */
export type LocationIdentityProductRow = ProductSelect & {
  category: ProductCategorySummary | null;
  images?: Array<{
    image: MappableImageRecord;
    deletedAt?: Date | null;
  }>;
};

export type LocationListDB = LocationSelect & {
  product?: LocationIdentityProductRow | null;
  parent: LocationSelect | null;
  children: Array<LocationSelect>;
  inventoryEntries: Array<
    typeof inventoryEntry.$inferSelect & {
      product: ProductSelect & {
        category: ProductCategorySummary | null;
        externalIds?: MappableProductExternalId[];
      };
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
  product?: LocationIdentityProductRow | null;
  children?: LocationWithParentChild[];
  parent?: LocationWithParentChild | null;
  images?: Array<{
    image: MappableImageRecord;
    deletedAt?: Date | null;
  }>;
  childCount?: number;
  /** Stock rows held directly; `directItemCount` is derived as its length. */
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
  productId?: string | string[];
  // "has" is the vessel set (a location that IS a tote/bin/rack); "none" is
  // rooms, areas and drawers.
  productPresenceFilter?: "has" | "none";
  parentId?: string | string[];
  parentPresenceFilter?: "has" | "none";
  // The inventory column's "(none)" / "Has inventory" sentinel — "none" is the
  // empty-shelf worklist. Counts only entries whose product is itself live.
  inventoryPresenceFilter?: "has" | "none";
  // The image column's "(none)" / "Has image" sentinel. Counts only displayable
  // images, matching the thumbnail cell — PDF attachments don't count.
  imagePresenceFilter?: "has" | "none";
  // Nullable column on the root table, so "none" is the un-described worklist.
  // Paired with `imagePresenceFilter: "has"` it's the describable backlog —
  // there's nothing to describe about a location with no photo.
  aiDescriptionPresenceFilter?: "has" | "none";
  // Direct children only, matching what the Parent column shows. "none" is the
  // leaf-location worklist.
  childPresenceFilter?: "has" | "none";
  // Older than N days, OR never recounted — the NULL half is part of the
  // predicate, since an uncounted bin is the worst offender, not an exempt one.
  lastBulkInventoryOlderThanDays?: number;
  directItemCountMin?: number;
  directItemCountMax?: number;
  valuationMin?: number;
  valuationMax?: number;
}
