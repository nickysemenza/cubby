import { locationTypeValues } from "@cubby/shared";
import { z } from "zod";
import { dbTimestampsOut, requiredName } from "./common";
import { locationId, locationShortcode } from "./identifiers";
import { createInputImages, imageOut, updateInputImages } from "./image";

export const locationType = z
  .enum(locationTypeValues)
  .describe("type of location (room, container, etc)");
export type LocationType = z.infer<typeof locationType>;

// Re-export for consumers that need the values array
export { locationTypeValues } from "@cubby/shared";

// Filters accepted by the location list endpoint.
export const locationFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  itemTypeFilter: locationType.optional(),
});

const locationBase = z.object({
  name: z.string().describe("name of location"),
  type: locationType,
});

// Per-category counts for a location's inventory (matches the client's
// PricingStatus buckets in calculate-inventory-valuation).
const pricingCounts = z.object({
  priced: z.number().int(),
  missingPricing: z.number().int(),
  miscNoPrice: z.number().int(),
});

/**
 * Precomputed inventory-valuation rollup stored on each location
 * (location.valuation), recomputed eagerly like recipe.totals.
 * `direct*` = items placed at this location; `total*` = direct + all descendants.
 */
export const locationValuation = z.object({
  directValuation: z.number(),
  totalValuation: z.number(),
  directItemCount: z.number().int(),
  totalItemCount: z.number().int(),
  direct: pricingCounts,
  total: pricingCounts,
});
export type LocationValuation = z.infer<typeof locationValuation>;

export const locationOut = z
  .object({
    id: locationId,
    shortcode: locationShortcode,
    lastBulkInventory: z.date().nullable(),
    aiDescription: z.string().nullable(),
    images: z.array(imageOut),
    // Persisted valuation rollup; null until first recompute.
    valuation: locationValuation.nullable(),
  })
  .extend(locationBase.shape)
  .extend(dbTimestampsOut.shape);

export type LocationOut = z.infer<typeof locationOut>;

export type {
  LocationListItemOut,
  LocationListRefOut,
} from "./location-responses";

// Helper to coerce empty strings to null for optional ID fields
const optionalLocationId = z
  .string()
  .nullable()
  .transform((val) => (val === "" ? null : val))
  .pipe(locationId.nullable());

// Input schema for creating locations
export const locationCreateInput = locationBase
  .extend({
    // Override the base `name` (which stays lax for reads) with a non-empty
    // constraint on the create/update boundary.
    name: requiredName("Location name").describe("name of location"),
    parentId: optionalLocationId.describe(
      "Parent location id — nest this location under another (omit/null for a top-level location).",
    ),
  })
  .merge(createInputImages);

// Input schema for updating locations
export const locationUpdateInput = z.object({
  id: locationId,
  data: locationCreateInput.partial().extend(updateInputImages.shape),
});

export type LocationCreateInput = z.infer<typeof locationCreateInput>;
export type LocationUpdateInput = z.infer<typeof locationUpdateInput>;
