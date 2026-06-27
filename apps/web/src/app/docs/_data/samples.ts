import {
  unsafeLocationId,
  unsafeLocationShortcode,
} from "@cubby/schemas/identifiers";
import type { LocationType } from "@cubby/schemas/location";
import type { infLocation } from "@cubby/schemas/location-responses";
import type { unitMappingWithMetadata } from "@cubby/schemas/unitmapping-responses";
import { generateLocationShortcode } from "@cubby/shared";
import { z } from "zod";
import type { entitySummaryDataSchema } from "~/components/entity/entity-summary-card";

const uuid = () => crypto.randomUUID();
const now = new Date();
const ts = { createdAt: now, updatedAt: now };

// Helper to create a location
const makeLocation = (
  name: string,
  type: LocationType,
  children?: z.infer<typeof infLocation>[],
): z.infer<typeof infLocation> => ({
  id: unsafeLocationId(uuid()),
  shortcode: unsafeLocationShortcode(generateLocationShortcode()),
  name,
  type,
  lastBulkInventory: null,
  aiDescription: null,
  images: [],
  valuation: null,
  ...ts,
  ...(children ? { children } : {}),
});

// Zod schema for rich text input (raw text + ingredient names for parsing)
export const richTextInputSchema = z.object({
  text: z.string(),
  ingredientNames: z.array(z.string()),
});

// DOT diagram for entity relationships
export const entityRelationshipsDot = `digraph {
  rankdir=TB;
  bgcolor="transparent";
  node [shape=box, style="rounded,filled", fillcolor="#f0f0f0", fontname="system-ui"];
  edge [fontname="system-ui", fontsize=10];

  Recipe [fillcolor="#fef3c7"];
  Ingredient [fillcolor="#dbeafe"];
  Product [fillcolor="#f3e8ff"];
  Location [fillcolor="#dcfce7"];
  Inventory [fillcolor="#fce7f3"];
  USDA [label="USDA Food", fillcolor="#e5e5e5", style="rounded,filled,dashed"];

  Recipe -> Ingredient [label="contains"];
  Product -> Ingredient [label="fulfills"];
  Product -> USDA [label="nutrition", style=dashed];
  Inventory -> Product [label="quantity of"];
  Inventory -> Location [label="stored in"];
  Location -> Location [label="nested in", style=dashed];
}`;

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
