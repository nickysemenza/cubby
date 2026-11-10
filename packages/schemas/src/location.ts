import {
  locationOut,
  locationDetailOut as infLocation,
  locationFilterFields as locationBaseFilterFields,
} from "@cubby/schemas/entities/location";
import { locationDetailNode } from "./generated/entity-field-envelopes.location.gen";
import { withFieldEnvelopes } from "./field-envelope";
import {
  locationFieldEnvelopeFields,
  locationPublicReadFields,
} from "./generated/entity-field-envelope-fields.location.gen";
import { rawLocationPickerReference } from "./location-raw-read";
import { z } from "zod";
import { numericRangeFields } from "./base-entity";
import { money } from "./money";
import { locationShortcode } from "./identifiers";
import { imageOut } from "./image";
import { presenceFilter } from "./pagination";
import {
  locationRefOut,
  locationListRefOut,
  locationType,
  locationValuation,
} from "./location-fields";

export { locationType, locationValuation } from "./location-fields";

export type LocationType = z.infer<typeof locationType>;

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

export { locationListRefOut } from "./location-fields";
export type LocationListRefOut = z.infer<typeof locationListRefOut>;

const locationAncestorOut = locationListRefOut;
export type LocationAncestorOut = z.infer<typeof locationAncestorOut>;

/** A deliberately lean inventory-count tree for the location drill-down. */
export type LocationInventoryBreakdownOut = {
  id: z.infer<typeof locationShortcode>;
  name: string;
  directItemCount: number;
  totalItemCount: number;
  children: LocationInventoryBreakdownOut[];
};

export const locationInventoryBreakdownOut: z.ZodType<LocationInventoryBreakdownOut> =
  z.lazy(() =>
    z.object({
      ...locationListRefOut.pick({ id: true, name: true }).shape,
      directItemCount: z.number().int().nonnegative(),
      totalItemCount: z.number().int().nonnegative(),
      children: z.array(locationInventoryBreakdownOut),
    }),
  );

/**
 * A roster row for a surface that also draws a thumbnail.
 *
 * `coverImage` is a separate SHAPE rather than a nullable field on
 * `locationOptionItemOut` on purpose: consumers that never draw a thumbnail
 * shouldn't pay the LocationImage⨝Image load or carry ~400 bytes of ImageOut
 * per row, and a `null` that meant "not requested" as well as "no photo" would
 * be the kind of ambiguity a reader can't resolve.
 */
export const locationPickerAncestorOut = withFieldEnvelopes(
  rawLocationPickerReference,
  { type: locationFieldEnvelopeFields.type },
  locationPublicReadFields,
);
export const locationPickerItemOut = locationPickerAncestorOut.extend({
  aliases: z.array(z.string()).default([]),
  ancestors: z.array(locationPickerAncestorOut),
  /** Compact resolved cover artifact, separate from editable Image records. */
  coverImage: imageOut.nullable(),
});
export type LocationPickerItemOut = z.infer<typeof locationPickerItemOut>;

export const locationWithParentNameOut = locationOut.extend({
  parentName: z.string().nullable(),
});

export const locationsWithParentNameOut = z.array(locationWithParentNameOut);

/** @public Names a generated native model. */
export const locationTreeNodeOut = locationDetailNode;
export type LocationTreeNode = z.output<typeof locationTreeNodeOut>;
export const inventoryItemForTree =
  infLocation.shape.inventoryItems.unwrap().element;
export type InventoryItemForTree = z.output<typeof inventoryItemForTree>;

export const infLocationListOut = z.array(infLocation);

export const locationShortcodesInput = z.object({
  shortcodes: z.array(locationShortcode),
});
