import { locationShortcode } from "@cubby/schemas/identifiers";
import type { infLocation, LocationType } from "@cubby/schemas/location";
import type { unitMappingWithMetadata } from "@cubby/schemas/unitmapping";
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
const shortcodeAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

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
    images: [],
    valuation: null,
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
export const sampleSummaryData: z.infer<typeof entitySummaryDataSchema> = {
  type: "recipe",
  data: {
    price: 8.45,
    weight: 650,
    nutrients: {
      "208": 2800, // kcal
      "203": 42, // protein
    },
    totalIngredients: 6,
    missingByType: {
      price: [],
      weight: [],
      nutrients: [],
    },
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
