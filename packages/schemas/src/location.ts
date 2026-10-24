import locationDefinition from "./entity-definitions/04-location.entity";
import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { numericRangeFields } from "./base-entity";
import { money } from "./money";
import { mutationSideEffectsSchema } from "./mutation-side-effects";
import { locationShortcode } from "./identifiers";
import { imageOut } from "./image";
import { createPaginatedResponseSchema, presenceFilter } from "./pagination";
import {
  locationRefOut,
  locationListRefOut,
  locationIdentityProductOut,
  locationType,
  locationValuation,
} from "./location-fields";
import { locationBaseFilterFields } from "./generated/location.gen";

export {
  locationCreateInput,
  locationUpdateData,
  locationUpdateInput,
  type LocationCreateInput,
  type LocationUpdateInput,
} from "./generated/location.gen";

export {
  locationIdentityProductOut,
  locationType,
  locationValuation,
} from "./location-fields";

export type LocationType = z.infer<typeof locationType>;

export { locationTypeValues } from "@cubby/shared";

export const locationFilterFields = {
  ...locationBaseFilterFields,
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
  aiDescriptionPresenceFilter: presenceFilter.describe(
    "Filter to locations that do / don't have an AI-generated description.",
  ),
  /**
   * Direct children only — `"none"` is the leaf-location worklist. Paired with
   * `inventoryPresenceFilter: "none"` it selects an empty leaf: a bin holding
   * nothing that also isn't a shelf for other bins.
   */
  childPresenceFilter: presenceFilter.describe(
    "Filter to locations that do / don't have at least one live child location.",
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
  locations: z.array(locationRefOut.extend({ value: money })),
});
export type LocationValuationSummaryOut = z.infer<
  typeof locationValuationSummaryOut
>;

/**
 * The SKU a location IS, embedded on every location read.
 *
 * Carries `category` for the linked location’s category glyph. Canonical
 * display images own the location thumbnail. `price` is
 * what the container-valuation bucket rolls up.
 */
export type LocationIdentityProductOut = z.infer<
  typeof locationIdentityProductOut
>;

export const locationOutFields = locationDefinition.readSchemas.output.shape;

export const locationOut = locationDefinition.readSchemas.output;

export type LocationOut = z.infer<typeof locationOut>;

export { locationListRefOut } from "./location-fields";
export type LocationListRefOut = z.infer<typeof locationListRefOut>;

/**
 * One rung of a location's ancestor chain. Ordered root-first and never
 * includes the location itself, so a dropdown row can disambiguate the many
 * legitimately-repeated names in the tree ("shelf 1" exists in four rooms).
 */
export const locationAncestorFields = locationListRefOut.shape;
export const locationAncestorOut = locationListRefOut;
export type LocationAncestorOut = z.infer<typeof locationAncestorOut>;

export const locationPathRefFields = locationListRefOut.shape;
export const locationPathRefOut = locationListRefOut.extend({
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
      ...locationListRefOut.shape,
      directItemCount: z.number().int().nonnegative(),
      totalItemCount: z.number().int().nonnegative(),
      children: z.array(locationInventoryBreakdownOut),
    }),
  );

/**
 * Breadcrumb-only roster row — scalar columns plus the ancestor chain that
 * tells repeated names apart ("shelf 1" exists in four rooms).
 *
 * Deliberately NOT `locationListItemOut` — that shape carries every inventory
 * entry, its full product embed, and a batched pricing pass that a picklist
 * discards. Same split as `productPickerItemOut`.
 */
const locationOptionItemFields = {
  ...locationListRefOut.shape,
  aliases: z.array(z.string()).default([]),
  ancestors: z.array(locationAncestorOut),
};

export const locationOptionItemOut = z.object(locationOptionItemFields);

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

export const locationListItemOut = locationDefinition.readSchemas.list;
const locationListItemFields = locationListItemOut.shape;
export type LocationListItemOut = z.infer<typeof locationListItemOut>;

export const locationWithParentNameOut = z.object({
  ...locationOutFields,
  parentName: z.string().nullable(),
});
export type LocationWithParentNameOut = z.infer<
  typeof locationWithParentNameOut
>;

export const locationsWithParentNameOut = z.array(locationWithParentNameOut);

export const infLocation = locationDefinition.readSchemas.detail;
export type InfLocation = z.output<typeof infLocation>;
export {
  inventoryItemForTree,
  type InventoryItemForTree,
} from "./location-fields";

export const infLocationListOut = z.array(infLocation);

export const infLocationWithSideEffects = infLocation.and(
  z.object({ sideEffects: mutationSideEffectsSchema }),
);

export const locationIdInput = z.object({
  id: locationShortcode,
});

export const locationShortcodesInput = z.object({
  shortcodes: z.array(locationShortcode),
});

export const locationShortcodeInput = z.object({
  shortcode: locationShortcode,
});

export const locationMcpOut = z.object({
  id: locationListItemFields.id,
  name: locationListItemFields.name,
  type: locationListItemFields.type,
  parent: locationListItemFields.parent,
  children: locationListItemFields.children,
});
export type LocationMcpOut = z.infer<typeof locationMcpOut>;

export const locationMcpListOut = createPaginatedResponseSchema(locationMcpOut);
