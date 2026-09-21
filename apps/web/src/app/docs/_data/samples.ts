import { locationShortcode } from "@cubby/schemas/identifiers";
import type { infLocation, LocationType } from "@cubby/schemas/location";
import {
  buildNutrition,
  type MeasureEstimate,
  withMacros,
} from "@cubby/schemas/nutrition";
import type { unitMappingWithMetadata } from "@cubby/schemas/unitmapping";
import { SHORTCODE_CHARS } from "@cubby/shared";
import { z } from "zod";

import type { entitySummaryDataSchema } from "~/components/entity/entity-summary-card";

// Deterministic ids/shortcodes for these static demo fixtures. We must NOT call
// crypto.randomUUID() / random shortcode generation at module top-level: workerd
// disallows generating random values in module (global) scope, and this module
// is evaluated during SSR — which crashed renderToReadableStream. A simple
// counter keeps the ids stable and unique, which is all the demos need.
const now = new Date(0);
const ts = { createdAt: now, updatedAt: now };
let locationSeq = 0;
const shortcodeAlphabet = SHORTCODE_CHARS;

// A demo fixture has nothing to say about data quality — every scored
// entity's read shape still requires the field.
const demoDataQuality = {
  status: "complete" as const,
  score: 100,
  facets: [],
  gaps: [],
  exceptions: [],
  relatedGaps: [],
  relatedExceptions: [],
};

// Helper to create a location
const makeLocation = (
  name: string,
  type: LocationType,
  children?: z.infer<typeof infLocation>[],
): z.infer<typeof infLocation> => {
  locationSeq += 1;
  const suffix = shortcodeAlphabet[locationSeq];
  if (!suffix) throw new Error("Location demo fixture capacity exceeded");
  const location: z.infer<typeof infLocation> = {
    id: locationShortcode.parse(`LOC-222${suffix}`),
    name,
    aliases: [],
    product: null,
    type,
    lastBulkInventory: null,
    aiDescription: null,
    notes: null,
    images: [],
    valuation: null,
    dataQuality: demoDataQuality,
    ...ts,
  };
  if (children !== undefined) location.children = children;
  return location;
};

// Zod schema for rich text input (raw text + ingredient names for parsing)
export const richTextInputSchema = z.object({
  text: z.string(),
  ingredientNames: z.array(z.string()),
});

// Sample data for ConversionCapabilities
export const sampleUnitMappings: z.infer<typeof unitMappingWithMetadata>[] = [
  {
    a: { value: 1, unit: "cup" },
    b: { value: 125, unit: "g" },
    source: "USDA",
    sourceMetadata: { type: "food", fdcId: 12345 },
  },
  {
    a: { value: 1, unit: "cup" },
    b: { value: 2.5, unit: "$" },
    source: "Manual",
    sourceMetadata: { type: "manual" },
  },
  {
    a: { value: 1, unit: "lb" },
    b: { value: 453.592, unit: "g" },
    source: "Standard",
    sourceMetadata: { type: "manual" },
  },
];

// Sample data for EntitySummaryCard
const completeEstimate = (lower: number, total: number): MeasureEstimate => ({
  status: "complete",
  lower,
  upper: null,
  coverage: { covered: total, total },
});

export const sampleSummaryData: z.infer<typeof entitySummaryDataSchema> = {
  type: "recipe",
  data: {
    ...withMacros({
      cost: completeEstimate(8.45, 6),
      nutrition: buildNutrition((key) => {
        if (key === "kcal") return completeEstimate(2800, 6);
        if (key === "protein") return completeEstimate(42, 6);
        return { status: "unavailable", reason: "no_data" };
      }),
    }),
    weight: completeEstimate(650, 6),
  },
};

// Sample data for formatRichText - raw instruction text and ingredient names
export const sampleRichTextInput = {
  text: "Add 2 cups of flour and 1 tsp of salt to the bowl.",
  ingredientNames: ["flour", "salt"],
};

// Sample data for LocationTreeView
export const sampleLocations: z.infer<typeof infLocation>[] = [
  makeLocation("Kitchen", "room", [
    makeLocation("Pantry", "cabinet", [
      makeLocation("Top Shelf", "shelf"),
      makeLocation("Bottom Shelf", "shelf"),
    ]),
    makeLocation("Refrigerator", "cabinet", [
      makeLocation("Crisper Drawer", "drawer"),
    ]),
  ]),
  makeLocation("Garage", "room", [makeLocation("Chest Freezer", "cabinet")]),
];
