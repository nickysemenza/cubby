import { locationTypeValues, productCategoryValues } from "@cubby/shared";
import { fdcId, upc } from "@cubby/usda-schemas";
import { z } from "zod";
import { locationRelatedFilterFields } from "./related-view";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
} from "./base-entity";
import { amount } from "./codec";
import { mutationSideEffectsSchema } from "./background-jobs";
import { requiredName } from "./common";
import {
  inventoryShortcode,
  locationShortcode,
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
  ...auditDateFilterFields,
  ...locationRelatedFilterFields,
  nameFilter: z
    .string()
    .optional()
    .describe("Filter by location name (substring)"),
  itemTypeFilter: oneOrMany(locationType).optional(),
  parentId: oneOrMany(locationShortcode).optional(),
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
  imagePresenceFilter: presenceFilter.describe(
    "Filter to locations that do / don't have at least one image (PDF attachments don't count).",
  ),
  directItemCountMin: z.coerce.number().int().nonnegative().optional(),
  directItemCountMax: z.coerce.number().int().nonnegative().optional(),
  valuationMin: z.coerce.number().optional(),
  valuationMax: z.coerce.number().optional(),
};

export const locationFiltersSchema = z.object(locationFilterFields);
export type LocationFiltersInput = z.infer<typeof locationFiltersSchema>;

export const locationSortableFields = [
  "createdAt",
  "updatedAt",
  "name",
  "type",
  // Joined parent name — resolved by a correlated subquery in repo/location.
  "parent",
  "lastBulkInventory",
  "valuation",
  "inventoryEntries",
] as const;

export type LocationSortField = (typeof locationSortableFields)[number];

/**
 * What the picker endpoint can actually order by. Narrower than
 * `locationSortableFields` on purpose — `locationSearch` loads no relations, so
 * the joined/rollup sorts (parent name, valuation, inventory count) have
 * nothing to sort on and must not be advertised.
 */
export const locationPickerSortableFields = [
  "name",
  "type",
  "createdAt",
  "updatedAt",
] as const;

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
  id: locationShortcode,
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
  id: locationShortcode,
  name: z.string(),
  type: locationType,
});
export type LocationListRefOut = z.infer<typeof locationListRefOut>;

/**
 * One rung of a location's ancestor chain. Ordered root-first and never
 * includes the location itself, so a dropdown row can disambiguate the many
 * legitimately-repeated names in the tree ("shelf 1" exists in four rooms).
 */
export const locationAncestorOut = z.object({
  id: locationShortcode,
  name: z.string(),
  type: locationType,
});
export type LocationAncestorOut = z.infer<typeof locationAncestorOut>;

/**
 * Lightweight `{id, name}` roster for the location filter's `parentLocation`
 * picklist (see `useLocationParentOptions`) — only locations with at least
 * one live child (repo/location/lookup.ts's `locationParentOptions`), not the
 * full location universe. Mirrors `projectOptionsOut`'s role for projects.
 */
export const locationParentOptionsOut = z.object({
  id: locationShortcode,
  name: z.string(),
  /** Root → immediate parent. Empty for a top-level location. */
  ancestors: z.array(locationAncestorOut),
});
export type LocationParentOptionsOut = z.infer<typeof locationParentOptionsOut>;

/**
 * Breadcrumb-only roster row — scalar columns plus the ancestor chain that
 * tells repeated names apart ("shelf 1" exists in four rooms).
 *
 * Deliberately NOT `locationListItemOut` — that shape carries every inventory
 * entry, its full product embed, and a batched pricing pass that a picklist
 * discards. Same split as `productPickerItemOut`.
 */
const locationOptionItemFields = {
  id: locationShortcode,
  name: z.string(),
  type: locationType,
  aliases: z.array(z.string()).default([]),
  /** Root → immediate parent. Empty for a top-level location. */
  ancestors: z.array(locationAncestorOut),
};

export const locationOptionItemOut = z.object(locationOptionItemFields);
export type LocationOptionItemOut = z.infer<typeof locationOptionItemOut>;

/**
 * A roster row for a surface that also draws a thumbnail.
 *
 * `coverImage` is a separate SHAPE rather than a nullable field on
 * `locationOptionItemOut` on purpose: consumers that never draw a thumbnail
 * shouldn't pay the LocationImage⨝Image load or carry ~400 bytes of ImageOut
 * per row, and a `null` that meant "not requested" as well as "no photo" would
 * be the kind of ambiguity a reader can't resolve.
 */
export const locationPickerItemOut = z.object({
  ...locationOptionItemFields,
  /** First displayable image by `imageOrder`; null when the location has none. */
  coverImage: imageOut.nullable(),
});
export type LocationPickerItemOut = z.infer<typeof locationPickerItemOut>;

const locationProductCategory = z.enum(productCategoryValues);

const locationInventoryProductOut = z.object({
  id: productShortcode,
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
  id: inventoryShortcode,
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

export const locationsWithParentNameOut = z.array(locationWithParentNameOut);

export const recomputeLocationValuationsOut = z.object({
  updated: z.number().int().nonnegative(),
});

const inventoryItemForTree = z.object({
  id: inventoryShortcode,
  amount,
  productName: z.string(),
  productId: productShortcode,
});
export type InventoryItemForTree = z.infer<typeof inventoryItemForTree>;

export type InfLocation = LocationOut & {
  children?: InfLocation[];
  parent?: InfLocation;
  childCount?: number;
  directItemCount?: number;
  totalItemCount?: number;
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

const optionalLocationShortcode = locationShortcode.nullable();

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
  parentId: optionalLocationShortcode.describe(
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
  id: locationShortcode,
  data: locationUpdateData,
});

export const locationBulkUpdateParentInput = z.object({
  ids: z.array(locationShortcode).min(1).max(3000),
  parentId: optionalLocationShortcode,
});

export const locationBulkUpdateParentOut = z.object({
  updated: z.number().int().nonnegative(),
});

export const locationIdInput = z.object({
  id: locationShortcode,
});

export const locationShortcodesInput = z.object({
  shortcodes: z.array(locationShortcode),
});

export const locationShortcodeInput = z.object({
  shortcode: locationShortcode,
});

export type LocationCreateInput = z.infer<typeof locationCreateInput>;
export type LocationUpdateInput = z.infer<typeof locationUpdateInput>;
export type LocationBulkUpdateParentInput = z.infer<
  typeof locationBulkUpdateParentInput
>;

export const mcpLocationCreateInput = z.object({
  name: requiredName("Location name").describe("name of location"),
  type: locationType,
  parentId: optionalLocationShortcode.describe(
    "Parent location id — nest this location under another (omit/null for a top-level location).",
  ),
});

/** Slim MCP projection of a location row (list or detail). */
export const locationMcpOut = z.object({
  id: locationShortcode,
  name: z.string(),
  type: locationType,
  parentName: z.string().nullable(),
  parentId: locationShortcode.nullable(),
  children: z.array(z.object({ id: locationShortcode, name: z.string() })),
});
export type LocationMcpOut = z.infer<typeof locationMcpOut>;

export const locationMcpListOut = createPaginatedResponseSchema(locationMcpOut);
