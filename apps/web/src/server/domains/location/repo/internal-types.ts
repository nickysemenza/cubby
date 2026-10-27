/**
 * Internal type definitions for location repository.
 * Types used across location modules.
 */

import type { InventoryItemForTree } from "@cubby/schemas/location-fields";
import type { RawProductCategorySummary } from "@cubby/schemas/product-category-fields";

import { type MappableImageRecord } from "~/server/db/helpers/transform";
import {
  type inventoryEntry,
  type location,
  type product,
} from "~/server/db/retained-tables";

/**
 * `aiDescription` is not a column: the read that loaded the row attaches the
 * latest live `location-description` AiAnalysis text (`ai-description.ts`).
 */
type LocationSelect = typeof location.$inferSelect & {
  aiDescription?: string | null;
};

import type { MappableProductExternalId } from "~/server/domains/product/repo/external-id-types";

type ProductSelect = typeof product.$inferSelect & { brandName: string | null };

/**
 * The identity product joined onto a location — the SKU the location IS.
 * Only identity columns; canonical media is prepared separately for the location.
 */
export type LocationIdentityProductRow = ProductSelect & {
  category: RawProductCategorySummary | null;
};

export type LocationListDB = LocationSelect & {
  product?: LocationIdentityProductRow | null;
  parent: LocationSelect | null;
  children: Array<LocationSelect>;
  inventoryEntries: Array<
    typeof inventoryEntry.$inferSelect & {
      // The stored valuation (ADR 0021), attached by the caller.
      valuation: number | null;
      product: ProductSelect & {
        category: RawProductCategorySummary | null;
        /** The stored effective price JSON, or the explicit price before publication. */
        effectivePrice: unknown;
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
  // Under these parents, including deeper sub-locations unless
  // `includeSubLocations` is false.
  parentId?: string | string[];
  parentPresenceFilter?: "has" | "none";
  includeSubLocations?: boolean;
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
  // Last recount day bounds; with "none", a never-recounted bin also matches.
  lastBulkInventoryFrom?: string;
  lastBulkInventoryTo?: string;
  lastBulkInventoryPresenceFilter?: "has" | "none";
  directItemCountMin?: number;
  directItemCountMax?: number;
  valuationMin?: number;
  valuationMax?: number;
}
