import { z } from "zod";
import { amount } from "./codec";
import { ingredientId, recipeId } from "./identifiers";
import { recipeTotals } from "./recipe";

// Status/indicator enums shared by the problem item schemas below.
export const invalidUpcIssue = z.enum(["invalid_format", "duplicate"]);
export const invalidInventoryAmountIssue = z.enum(["zero", "negative"]);
export const wrongCategoryIndicator = z.enum(["fdc", "ingredient"]);

// Output schemas for each problem type.
export const duplicateUniqueProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  expectedQuantity: z.number().nullable(),
  locations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
});

export const orphanedProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  createdAt: z.date(),
});

export const invalidUPCSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  upc: z.string(),
  issue: invalidUpcIssue,
});

export const productWithoutMappingsSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  createdAt: z.date(),
  isIngredient: z.boolean(),
  usdaUnavailable: z.boolean(),
});

export const ingredientWithPartialCoverageSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  coverage: z.object({ covered: z.array(z.string()) }),
  hasPrice: z.boolean(),
  hasUsdaLink: z.boolean(),
  usdaUnavailable: z.boolean(),
});

export const invalidInventoryAmountSchema = z.object({
  id: z.string(),
  productName: z.string(),
  locationName: z.string(),
  amount,
  issue: invalidInventoryAmountIssue,
});

export const emptyLocationSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  createdAt: z.date(),
  lastBulkInventory: z.date().nullable(),
  aiDescription: z.string().nullable(),
  firstImageUrl: z.string().nullable(),
  firstImageId: z.string().nullable(),
});

export const productWithNoImagesSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  upc: z.string().nullable(),
});

export const productWithWrongCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  category: z.string().nullable(),
  indicator: wrongCategoryIndicator,
});

export const inventoryWithStaleValuationSchema = z.object({
  id: z.string(),
  productName: z.string(),
  locationName: z.string(),
  storedValuation: z.number().nullable(),
  expectedValuation: z.number().nullable(),
});

export const productWithIslandedMappingsSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  islandCount: z.number(),
  islands: z.array(
    z.object({
      units: z.array(z.string()),
      exampleUnit: z.string(),
    }),
  ),
  coverage: z.object({ covered: z.array(z.string()) }),
});

export const locationWithoutAiDescriptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  imageCount: z.number(),
});

export const staleIngredientParseSchema = z.object({
  recipeSectionIngredientId: z.string(),
  recipeId,
  recipeName: z.string(),
  ingredientId,
  storedName: z.string(),
  rawLine: z.string(),
  parsedName: z.string(),
  nameDrift: z.boolean(),
  storedAmounts: z.array(amount),
  parsedAmounts: z.array(amount),
  amountDrift: z.boolean(),
  storedModifier: z.string().nullable(),
  parsedModifier: z.string().nullable(),
  modifierDrift: z.boolean(),
});

export const productWithBetterUpcDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
  upc: z.string(),
  gaps: z.object({
    manufacturer: z.boolean(),
    price: z.boolean(),
    image: z.boolean(),
  }),
});

export const staleRecipeTotalsSchema = z.object({
  recipeId,
  recipeName: z.string(),
  totals: recipeTotals.nullable(),
});

// Combined output schema for all problems.
export const allProblemsSchema = z.object({
  duplicateUniqueProducts: z.array(duplicateUniqueProductSchema),
  orphanedProducts: z.array(orphanedProductSchema),
  invalidUPCs: z.array(invalidUPCSchema),
  productsWithoutMappings: z.array(productWithoutMappingsSchema),
  ingredientsWithPartialCoverage: z.array(ingredientWithPartialCoverageSchema),
  inventoryWithStaleValuations: z.array(inventoryWithStaleValuationSchema),
  invalidInventoryAmounts: z.array(invalidInventoryAmountSchema),
  emptyLocations: z.array(emptyLocationSchema),
  productsWithNoImages: z.array(productWithNoImagesSchema),
  productsWithWrongCategory: z.array(productWithWrongCategorySchema),
  productsWithIslandedMappings: z.array(productWithIslandedMappingsSchema),
  locationsWithoutAiDescription: z.array(locationWithoutAiDescriptionSchema),
  staleIngredientParses: z.array(staleIngredientParseSchema),
  staleRecipeTotals: z.array(staleRecipeTotalsSchema),
  productsWithBetterUpcData: z.array(productWithBetterUpcDataSchema),
  totalProblems: z.number(),
});

// Count-only output schema for badge display.
export const problemsCountSchema = z.object({
  total: z.number(),
  byType: z.object({
    duplicateUniqueProducts: z.number(),
    orphanedProducts: z.number(),
    invalidUPCs: z.number(),
    productsWithoutMappings: z.number(),
    ingredientsWithPartialCoverage: z.number(),
    invalidInventoryAmounts: z.number(),
    emptyLocations: z.number(),
    productsWithNoImages: z.number(),
    productsWithWrongCategory: z.number(),
    inventoryWithStaleValuations: z.number(),
    productsWithIslandedMappings: z.number(),
    locationsWithoutAiDescription: z.number(),
    staleIngredientParses: z.number(),
    staleRecipeTotals: z.number(),
    productsWithBetterUpcData: z.number(),
  }),
});

export type AllProblems = z.infer<typeof allProblemsSchema>;
export type ProblemsCount = z.infer<typeof problemsCountSchema>;

// Counts powering the Settings → Maintenance "N affected" dry-run. A focused
// subset (the six batch tools shown there), kept separate from problemsCount so
// it can run only cheap DB/WASM detectors — no USDA/UPC network.
export const maintenanceCountsSchema = z.object({
  recipesTotal: z.number().int(),
  staleParses: z.number().int(),
  staleValuations: z.number().int(),
  productsNoImages: z.number().int(),
  wrongCategory: z.number().int(),
  locationsNoDescription: z.number().int(),
});
export type MaintenanceCounts = z.infer<typeof maintenanceCountsSchema>;
