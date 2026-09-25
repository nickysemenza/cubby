import { productCategorySummary } from "./product-category-fields";
import { fdcId } from "@cubby/usda-schemas";
import { gtin } from "./external-id";
import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { locationRelatedFilterFields } from "./related-view";
import {
  generatedLocationFieldSchemas,
  generatedLocationFilterFields,
} from "./generated/entity-field-schemas.location.gen";
import {
  auditDateFilterFields,
  numericRangeFields,
  timestampedFields,
} from "./base-entity";
import { amount } from "./codec";
import { money, moneyNullable } from "./money";
import { mutationSideEffectsSchema } from "./background-jobs";
import {
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import { firstDisplayableImage, type ImageOut, imageOut } from "./image";
import {
  createPaginatedResponseSchema,
  entityFilterList,
  presenceFilter,
} from "./pagination";
import {
  locationIdentityProductOut,
  locationType,
  locationValuation,
} from "./location-fields";
import { displayImagesField } from "./display-images";

export {
  locationIdentityProductOut,
  locationType,
  locationValuation,
} from "./location-fields";

export type LocationType = z.infer<typeof locationType>;

export { locationTypeValues } from "@cubby/shared";

export const locationFilterFields = {
  ...auditDateFilterFields,
  ...locationRelatedFilterFields,
  ...generatedLocationFilterFields,
  /**
   * Locations that ARE this product. Matches the identity link, not stock
   * held at the location — for that, use the inventory list.
   */
  productId: entityFilterList(productShortcode).optional(),
  productPresenceFilter: presenceFilter.describe(
    'Filter to locations that are / aren\'t an instance of a Product. "has" is the vessel set (totes, bins, racks); "none" is rooms, areas and drawers.',
  ),
  parentId: entityFilterList(locationShortcode).optional(),
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
  /**
   * Direct children only — `"none"` is the leaf-location worklist. Paired with
   * `inventoryPresenceFilter: "none"` it selects an empty leaf: a bin holding
   * nothing that also isn't a shelf for other bins.
   */
  childPresenceFilter: presenceFilter.describe(
    "Filter to locations that do / don't have at least one live child location.",
  ),
  /**
   * Locations whose last deliberate recount is older than N days — or that have
   * never been recounted at all.
   *
   * Relative rather than an absolute date pair on purpose: this is the shape a
   * static declaration can hold. Every other date control in the manifest
   * expands to absolute `yyyy-MM-dd` strings computed from the browser's clock,
   * which a saved view could never pin — the value would change daily.
   *
   * The never-recounted half is part of the predicate, not an oversight. A
   * plain `<` bound drops NULLs, and a bin nobody has ever counted is the worst
   * offender rather than an exempt one.
   */
  lastBulkInventoryOlderThanDays: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Locations last recounted more than this many days ago, or never recounted.",
    ),
  ...numericRangeFields("directItemCount", { int: true, nonnegative: true }),
  ...numericRangeFields("valuation"),
};

export const locationFiltersSchema = z.object(locationFilterFields);
export type LocationFiltersInput = z.infer<typeof locationFiltersSchema>;

export type LocationSortField = GeneratedEntitySortField<"location">;

/**
 * What the picker endpoint can actually order by. Narrower than the
 * declared `location` entity sort roster on purpose — `locationSearch` loads
 * no relations, so
 * the joined/rollup sorts (parent name, valuation, inventory count) have
 * nothing to sort on and must not be advertised.
 */
export const locationPickerSortableFields = [
  "name",
  "type",
  "createdAt",
  "updatedAt",
] as const;

/**
 * The four headline figures are STOCK ONLY — what you could walk over and
 * count. Fixed installations roll up separately in `installed`, because
 * "what's on this shelf" and "what is this room worth" are different questions
 * and a dimmer wired into the wall answers only the second.
 *
 * `installed` is optional so rows persisted before placement existed still
 * parse; the rollup always emits it, so a missing key means the location has
 * not been recomputed since.
 */
export type LocationValuation = z.infer<typeof locationValuation>;

export const locationValuationSummaryOut = z.object({
  total: money,
  locations: z.array(
    z.object({
      id: locationShortcode,
      name: z.string(),
      value: money,
    }),
  ),
});
export type LocationValuationSummaryOut = z.infer<
  typeof locationValuationSummaryOut
>;

/**
 * The SKU a location IS, embedded on every location read.
 *
 * Carries `category` and `coverImage` because they drive the location's own
 * visual identity: the category icon is the glyph a linked location renders at
 * small sizes (its `type` is null), and the cover is its thumbnail. `price` is
 * what the container-valuation bucket rolls up.
 */
export type LocationIdentityProductOut = z.infer<
  typeof locationIdentityProductOut
>;

/**
 * The image that represents a location: its own first displayable photo, else
 * the cover of the SKU it IS.
 *
 * `locationIdentityProductOut.coverImage` was built for exactly this fallback
 * and had no reader until this existed — every location surface resolved only
 * `images`, so a bin that IS a photographed tote rendered the empty placeholder.
 *
 * Structurally typed rather than taking a `LocationOut`, so the list row, the
 * detail read, and the hover-card view-model all satisfy it.
 */
export const locationCoverImage = (loc: {
  images: ImageOut[];
  product: { coverImage: ImageOut | null } | null;
}): ImageOut | null =>
  // `mapLocationIdentityProduct` filters the cover too, but a caller may hand
  // us one from somewhere else; the predicate is the contract, not the mapper.
  firstDisplayableImage<ImageOut>(loc.images, loc.product?.coverImage);

export const locationOutFields = {
  ...generatedLocationFieldSchemas.read,
};

export const locationOut = z.object(locationOutFields);

export type LocationOut = z.infer<typeof locationOut>;

export const locationListRefOut = z.object({
  id: locationShortcode,
  name: z.string(),
  type: locationType.nullable(),
});
export type LocationListRefOut = z.infer<typeof locationListRefOut>;

/**
 * One rung of a location's ancestor chain. Ordered root-first and never
 * includes the location itself, so a dropdown row can disambiguate the many
 * legitimately-repeated names in the tree ("shelf 1" exists in four rooms).
 */
export const locationAncestorFields = {
  id: locationShortcode,
  name: z.string(),
  type: locationType.nullable(),
};
export const locationAncestorOut = z.object(locationAncestorFields);
export type LocationAncestorOut = z.infer<typeof locationAncestorOut>;

export const locationPathRefFields = {
  id: locationShortcode,
  name: z.string(),
  type: locationType.nullable(),
};
export const locationPathRefOut = z.object({
  ...locationPathRefFields,
  ancestors: z.array(locationAncestorOut),
});
export type LocationPathRefOut = z.infer<typeof locationPathRefOut>;

/** A deliberately lean inventory-count tree for the location drill-down. */
export type LocationInventoryBreakdownOut = {
  id: z.infer<typeof locationShortcode>;
  name: string;
  type: LocationType | null;
  directItemCount: number;
  totalItemCount: number;
  children: LocationInventoryBreakdownOut[];
};

export const locationInventoryBreakdownOut: z.ZodType<LocationInventoryBreakdownOut> =
  z.lazy(() =>
    z.object({
      id: locationShortcode,
      name: z.string(),
      type: locationType.nullable(),
      directItemCount: z.number().int().nonnegative(),
      totalItemCount: z.number().int().nonnegative(),
      children: z.array(locationInventoryBreakdownOut),
    }),
  );

/**
 * Lightweight `{id, name}` roster for the location filter's `parentLocation`
 * picklist (see `useLocationParentOptions`) — only locations with at least
 * one live child (repo/location/lookup.ts's `locationParentOptions`), not the
 * full location universe. Mirrors `projectOptionsOut`'s role for projects.
 */
export const locationParentOptionsOut = z.object({
  id: locationShortcode,
  name: z.string(),
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
  type: locationType.nullable(),
  aliases: z.array(z.string()).default([]),
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
  /**
   * Resolved display cover: the location's first displayable image by
   * `imageOrder`, then its identity product's first displayable cover. This is
   * presentation-only; product imagery is never treated as a LocationImage.
   */
  coverImage: imageOut.nullable(),
});
export type LocationPickerItemOut = z.infer<typeof locationPickerItemOut>;

const locationProductCategory = productCategorySummary;

const locationInventoryProductOut = z.object({
  id: productShortcode,
  name: z.string(),
  primaryGtin: gtin.nullable(),
  fdc_id: fdcId.nullable(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  notes: z.string().nullable(),
  expectedQuantity: z.number().int().positive().nullable(),
  category: locationProductCategory.nullable(),
  price: moneyNullable,
  usdaUnavailable: z.boolean().nullable(),
  ...timestampedFields,
});

const locationInventoryWithProductOut = z.object({
  id: inventoryShortcode,
  amount,
  valuation: moneyNullable,
  ...timestampedFields,
  product: locationInventoryProductOut,
});

const locationListItemFields = {
  ...locationOutFields,
  displayImages: displayImagesField,
  children: z.array(locationListRefOut),
  parent: locationListRefOut.nullable(),
  inventoryEntries: z.array(locationInventoryWithProductOut),
};

export const locationListItemOut = z.object(locationListItemFields);
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

const optionalLocationShortcode = locationShortcode.nullable().optional();

export const locationCreateInput = z.object(
  generatedLocationFieldSchemas.create,
);

export const locationUpdateData = z.object(
  generatedLocationFieldSchemas.update,
);

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

export const locationMcpOut = z.object({
  id: locationListItemFields.id,
  name: locationListItemFields.name,
  type: locationListItemFields.type,
  parent: locationListItemFields.parent,
  children: locationListItemFields.children,
});
export type LocationMcpOut = z.infer<typeof locationMcpOut>;

export const locationMcpListOut = createPaginatedResponseSchema(locationMcpOut);
