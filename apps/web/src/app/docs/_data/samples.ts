import { z } from "zod";
import type { entitySummaryDataSchema } from "~/components/entity/entity-summary-card";
import { unsafeLocationId } from "~/schemas/identifiers";
import type { infLocation, LocationType } from "~/schemas/location";
import type { recipeOut } from "~/schemas/recipe";
import type { unitMappingWithMetadata } from "~/schemas/unitmapping";

const uuid = () => crypto.randomUUID();
const now = new Date();
const ts = { createdAt: now, updatedAt: now };

// Helper to create a recipe ingredient
const makeIngredient = (
  id: string,
  name: string,
  value: number,
  unit: string,
) => ({
  id: `ing-${id}`,
  type: "ingredient" as const,
  amounts: [{ value, unit }],
  ingredient: { id: `${id}-id`, name, ...ts },
  recipe: null,
  ...ts,
});

// Helper to create a location
const makeLocation = (
  name: string,
  type: LocationType,
  children?: z.infer<typeof infLocation>[],
): z.infer<typeof infLocation> => ({
  id: unsafeLocationId(uuid()),
  name,
  type,
  lastBulkInventory: null,
  images: [],
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

// Sample data for NYTView
export const sampleRecipe: z.infer<typeof recipeOut> = {
  id: "sample-recipe-id",
  name: "Classic Chocolate Chip Cookies",
  meta: { url: "https://example.com/cookies" },
  images: [],
  ...ts,
  sections: [
    {
      id: "section-1",
      name: "Dough",
      ...ts,
      ingredients: [
        makeIngredient("1", "all-purpose flour", 2.25, "cup"),
        makeIngredient("2", "salt", 1, "tsp"),
        makeIngredient("3", "unsalted butter, softened", 1, "cup"),
        makeIngredient("4", "granulated sugar", 0.75, "cup"),
        makeIngredient("5", "large eggs", 2, "whole"),
        makeIngredient("6", "chocolate chips", 2, "cup"),
      ],
      instructions: [
        { instruction: "Preheat oven to 375°F (190°C)." },
        {
          instruction: "Combine flour, baking soda, and salt in a small bowl.",
        },
        {
          instruction:
            "Beat butter, granulated sugar, and brown sugar until creamy.",
        },
        { instruction: "Add eggs and vanilla; beat until combined." },
        {
          instruction:
            "Gradually blend in flour mixture. Stir in chocolate chips.",
        },
        {
          instruction: "Drop rounded tablespoons onto ungreased baking sheets.",
        },
        { instruction: "Bake for 9 to 11 minutes or until golden brown." },
      ],
    },
  ],
};

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
