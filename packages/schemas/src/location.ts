import { locationTypeValues, productCategoryValues } from "@cubby/shared";
import { fdcId, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import { amount } from "./codec";
import { mutationSideEffectsSchema } from "./background-jobs";
import { requiredName } from "./common";
import {
  inventoryId,
  locationId,
  locationShortcode,
  productId,
  productShortcode,
} from "./identifiers";
import { imageOut } from "./image";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";

export const locationType = z
  .enum(locationTypeValues)
  .describe("type of location (room, container, etc)");
export type LocationType = z.infer<typeof locationType>;

// Re-export for consumers that need the values array
export { locationTypeValues } from "@cubby/shared";

// Filters accepted by the location list endpoint.
export const locationFilterFields = {
  nameFilter: z
    .string()
    .optional()
    .describe("Filter by location name (substring)"),
  itemTypeFilter: oneOrMany(locationType).optional(),
  parentId: oneOrMany(locationId).optional(),
  parentPresenceFilter: presenceFilter,
  /**
   * `"none"` is the empty-shelf worklist. Counts only entries whose product is
   * itself live — `dbLocationToListAPI` drops entries on soft-deleted products,
   * so a shelf holding only deleted products renders empty and must filter as
   * empty too.
   */
  inventoryPresenceFilter: presenceFilter.describe(
    "Filter to locations that do / don't hold at least one live inventory entry",
  ),
};

export const locationFiltersSchema = z.object(locationFilterFields);
export type LocationFiltersInput = z.infer<typeof locationFiltersSchema>;

export const locationSortableFields = [
  "createdAt",
  "name",
  "type",
  // Joined parent name — resolved by a correlated subquery in repo/location.
  "parent",
  "lastBulkInventory",
  "valuation",
] as const;

export type LocationSortField = (typeof locationSortableFields)[number];

// Per-category counts for a location's inventory (matches the client's
// PricingStatus buckets in calculate-inventory-valuation).
const pricingCounts = z.object({
  priced: z.number().int().nonnegative(),
  missingPricing: z.number().int().nonnegative(),
  miscNoPrice: z.number().int().nonnegative(),
});

/**
 * Precomputed inventory-valuation rollup stored on each location
 * (location.valuation), recomputed eagerly like recipe.totals.
 * `direct*` = items placed at this location; `total*` = direct + all descendants.
 */
export const locationValuation = z.object({
  directValuation: z.number(),
  totalValuation: z.number(),
  directItemCount: z.number().int().nonnegative(),
  totalItemCount: z.number().int().nonnegative(),
  direct: pricingCounts,
  total: pricingCounts,
});
export type LocationValuation = z.infer<typeof locationValuation>;

export const locationOutFields = {
  id: locationId,
  shortcode: locationShortcode,
  name: z.string().describe("name of location"),
  aliases: z
    .array(z.string())
    .default([])
    .describe("Alternate names for this location (searched + embedded)"),
  type: locationType,
  lastBulkInventory: z.date().nullable(),
  aiDescription: z.string().nullable(),
  images: z.array(imageOut),
  // Persisted valuation rollup; null until first recompute.
  valuation: locationValuation.nullable(),
  ...timestampedFields,
};

export const locationOut = z.object(locationOutFields);

export type LocationOut = z.infer<typeof locationOut>;

export const locationListRefOut = z.object({
  id: locationId,
  shortcode: locationShortcode,
  name: z.string(),
  type: locationType,
});
export type LocationListRefOut = z.infer<typeof locationListRefOut>;

/**
 * Lightweight `{id, name}` roster for the location filter's `parentLocation`
 * picklist (see `useLocationParentOptions`) — only locations with at least
 * one live child (repo/location/lookup.ts's `locationParentOptions`), not the
 * full location universe. Mirrors `projectOptionsOut`'s role for projects.
 */
export const locationParentOptionsOut = z.object({
  id: locationId,
  name: z.string(),
});
export type LocationParentOptionsOut = z.infer<typeof locationParentOptionsOut>;

const locationProductCategory = z.enum(productCategoryValues);

const locationInventoryProductOut = z.object({
  id: productId,
  shortcode: productShortcode,
  name: z.string(),
  upc: upc.nullable(),
  fdc_id: fdcId.nullable(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  notes: z.string().nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  category: locationProductCategory.nullable(),
  price: z.number().nullable(),
  usdaUnavailable: z.boolean().nullable(),
  ...timestampedFields,
});

const locationInventoryWithProductOut = z.object({
  id: inventoryId,
  amount,
  valuation: z.number().nullable(),
  ...timestampedFields,
  product: locationInventoryProductOut,
});

export const locationListItemOut = z.object({
  ...locationOutFields,
  children: z.array(locationListRefOut),
  parent: locationListRefOut.nullable(),
  inventoryEntries: z.array(locationInventoryWithProductOut),
});
export type LocationListItemOut = z.infer<typeof locationListItemOut>;

export const locationWithParentNameOut = z.object({
  ...locationOutFields,
  parentName: z.string().nullable(),
});
export type LocationWithParentNameOut = z.infer<
  typeof locationWithParentNameOut
>;

export const locationTypeCountsOut = z.record(
  locationType,
  z.number().int().nonnegative(),
);

export const locationsWithParentNameOut = z.array(locationWithParentNameOut);

export const recentlyActiveLocationsOut = z.array(locationOut);

export const recomputeLocationValuationsOut = z.object({
  updated: z.number().int().nonnegative(),
});

export const locationChildCountsOut = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

/** Minimal inventory item info for tree display */
const inventoryItemForTree = z.object({
  id: inventoryId,
  amount,
  productName: z.string(),
  productId,
});
export type InventoryItemForTree = z.infer<typeof inventoryItemForTree>;

export type InfLocation = LocationOut & {
  children?: InfLocation[];
  parent?: InfLocation;
  /** Number of direct child locations */
  childCount?: number;
  /** Number of inventory items directly at this location */
  directItemCount?: number;
  /** Number of inventory items at this location and all descendants */
  totalItemCount?: number;
  /** Inventory items at this location (for expanded tree view) */
  inventoryItems?: InventoryItemForTree[];
};

export const infLocation: z.ZodType<InfLocation> = z.object({
  ...locationOutFields,
  children: z.lazy(() => infLocation.array()).optional(),
  parent: z.lazy(() => infLocation.optional()),
  childCount: z.number().int().nonnegative().optional(),
  directItemCount: z.number().int().nonnegative().optional(),
  totalItemCount: z.number().int().nonnegative().optional(),
  inventoryItems: z.array(inventoryItemForTree).optional(),
});

export const infLocationListOut = z.array(infLocation);

export const infLocationWithSideEffects = infLocation.and(
  z.object({ sideEffects: mutationSideEffectsSchema }),
);

// Helper to coerce empty strings to null for optional ID fields
const optionalLocationId = z
  .string()
  .nullable()
  .transform((val) => (val === "" ? null : val))
  .pipe(locationId.nullable());

// Input schema for creating locations
const locationCreateShape = {
  // Override the output/read `name` (which stays lax for reads) with a non-empty
  // constraint on the create/update boundary.
  name: requiredName("Location name").describe("name of location"),
  aliases: z
    .array(z.string())
    .default([])
    .describe(
      "Alternate names for this location — searched alongside the name. Replaces the existing list when provided.",
    ),
  type: locationType,
  parentId: optionalLocationId.describe(
    "Parent location id — nest this location under another (omit/null for a top-level location).",
  ),
  pendingImageIds: z.array(z.uuid()).optional(),
};

export const locationCreateInput = z.object(locationCreateShape);

// Every create field optional; `removeImageIds` is update-only. (The update
// `parentId` inherits the create field's description — harmless doc, same type.)
export const locationUpdateData = deriveUpdateData(locationCreateShape, {
  extend: {
    removeImageIds: z.array(z.uuid()).optional(),
    imageOrder: z
      .array(z.uuid())
      .optional()
      .describe("existing image ids in display order; first = cover"),
  },
});

// Input schema for updating locations
export const locationUpdateInput = z.object({
  id: locationId,
  data: locationUpdateData,
});

export const locationBulkUpdateParentInput = z.object({
  ids: z.array(locationId).min(1),
  parentId: optionalLocationId,
});

export const locationBulkUpdateParentOut = z.object({
  updated: z.number().int().nonnegative(),
});

export const locationIdInput = z.object({
  id: locationId,
});

export const locationShortcodesInput = z.object({
  shortcodes: z.array(locationShortcode),
});

export const locationShortcodeInput = z.object({
  shortcode: locationShortcode,
});

export const recentlyActiveLocationsInput = z
  .object({
    limit: z.number().int().min(1).max(10).default(5),
  })
  .optional();

export const locationIdsInput = z.object({
  locationIds: z.array(locationId),
});

export type LocationCreateInput = z.infer<typeof locationCreateInput>;
export type LocationUpdateInput = z.infer<typeof locationUpdateInput>;
export type LocationBulkUpdateParentInput = z.infer<
  typeof locationBulkUpdateParentInput
>;

export const mcpLocationCreateInput = z.object({
  name: requiredName("Location name").describe("name of location"),
  type: locationType,
  parentId: optionalLocationId.describe(
    "Parent location id — nest this location under another (omit/null for a top-level location).",
  ),
});

/** Slim MCP projection of a location row (list or detail). */
export const locationMcpOut = z.object({
  id: locationId,
  name: z.string(),
  shortcode: locationShortcode,
  type: locationType,
  parentName: z.string().nullable(),
  parentId: locationId.nullable(),
  children: z.array(z.object({ id: locationId, name: z.string() })),
});
export type LocationMcpOut = z.infer<typeof locationMcpOut>;

export const locationMcpListOut = createPaginatedResponseSchema(locationMcpOut);
