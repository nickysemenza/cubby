import { z } from "zod";
import { amount } from "./codec";
import { ingredientId, recipeId } from "./identifiers";
import { recipeTotals } from "./recipe";

// Status/indicator enums shared by the problem item schemas below.
export const invalidUpcIssue = z.enum(["invalid_format", "duplicate"]);
export const invalidInventoryAmountIssue = z.enum(["zero", "negative"]);
export const wrongCategoryIndicator = z.enum(["fdc", "ingredient"]);

// The four base measurement kinds a product's conversion graph can reach. The
// single source for the BaseKind union: the costing lib (conversion-coverage)
// re-exports BASE_KINDS/BaseKind from this, and the coverage-bearing problem
// schemas below carry the union natively (no parallel repo type needed).
export const baseKind = z.enum(["weight", "volume", "money", "calories"]);
export type BaseKind = z.infer<typeof baseKind>;

// Shared field fragments — the product-summary head and the coverage shape
// repeat across many item schemas, so declare them once and .extend().
const productProblemBase = z.object({
  id: z.string(),
  name: z.string(),
  manufacturer: z.string(),
});
const coverageShape = z.object({ covered: z.array(baseKind) });

// Output schemas for each problem type.
export const duplicateUniqueProductSchema = productProblemBase.extend({
  expectedQuantity: z.number().nullable(),
  locations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
});

export const orphanedProductSchema = productProblemBase.extend({
  createdAt: z.date(),
});

export const invalidUPCSchema = productProblemBase.extend({
  upc: z.string(),
  issue: invalidUpcIssue,
});

export const productWithoutMappingsSchema = productProblemBase.extend({
  createdAt: z.date(),
  isIngredient: z.boolean(),
  usdaUnavailable: z.boolean(),
});

export const ingredientWithPartialCoverageSchema = productProblemBase.extend({
  coverage: coverageShape,
  hasPrice: z.boolean(),
  hasUsdaLink: z.boolean(),
  usdaUnavailable: z.boolean(),
});

export const ingredientWithoutProductSchema = z.object({
  id: ingredientId,
  name: z.string(),
  recipeCount: z.number(),
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

export const productWithNoImagesSchema = productProblemBase.extend({
  upc: z.string().nullable(),
});

export const productWithWrongCategorySchema = productProblemBase.extend({
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

export const productWithIslandedMappingsSchema = productProblemBase.extend({
  islandCount: z.number(),
  islands: z.array(
    z.object({
      units: z.array(z.string()),
      exampleUnit: z.string(),
    }),
  ),
  coverage: coverageShape,
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

export const productWithBetterUpcDataSchema = productProblemBase.extend({
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
  ingredientsWithoutProduct: z.array(ingredientWithoutProductSchema),
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

// Count-only output schema for badge display. byType derives mechanically from
// allProblemsSchema — every array key becomes a count — so the count roster
// can't drift from the set of detectors (the runtime derives it the same way).
const { totalProblems: _total, ...problemArrays } = allProblemsSchema.shape;
const byTypeShape = Object.fromEntries(
  Object.keys(problemArrays).map((k) => [k, z.number()]),
) as { [K in keyof typeof problemArrays]: z.ZodNumber };

export const problemsCountSchema = z.object({
  total: z.number(),
  byType: z.object(byTypeShape),
});

export type AllProblems = z.infer<typeof allProblemsSchema>;
export type ProblemsCount = z.infer<typeof problemsCountSchema>;

// Per-detector item types — the canonical shapes the problems repo's find*
// functions return, inferred from the schemas above so the repo never restates
// them. `coverage.covered` carries the BaseKind union natively (via baseKind).
export type DuplicateUniqueProduct = z.infer<
  typeof duplicateUniqueProductSchema
>;
export type OrphanedProduct = z.infer<typeof orphanedProductSchema>;
export type InvalidUPC = z.infer<typeof invalidUPCSchema>;
export type ProductWithoutMappings = z.infer<
  typeof productWithoutMappingsSchema
>;
export type IngredientWithPartialCoverage = z.infer<
  typeof ingredientWithPartialCoverageSchema
>;
export type IngredientWithoutProduct = z.infer<
  typeof ingredientWithoutProductSchema
>;
export type InvalidInventoryAmount = z.infer<
  typeof invalidInventoryAmountSchema
>;
export type EmptyLocation = z.infer<typeof emptyLocationSchema>;
export type ProductWithWrongCategory = z.infer<
  typeof productWithWrongCategorySchema
>;
export type InventoryWithStaleValuation = z.infer<
  typeof inventoryWithStaleValuationSchema
>;
export type ProductWithIslandedMappings = z.infer<
  typeof productWithIslandedMappingsSchema
>;
export type LocationWithoutAiDescription = z.infer<
  typeof locationWithoutAiDescriptionSchema
>;
export type StaleIngredientParse = z.infer<typeof staleIngredientParseSchema>;
export type StaleRecipeTotals = z.infer<typeof staleRecipeTotalsSchema>;
export type ProductWithBetterUpcData = z.infer<
  typeof productWithBetterUpcDataSchema
>;

// Counts powering the Settings → Maintenance "N affected" dry-run. A focused
// subset (the batch tools shown there), kept separate from problemsCount so it
// can run only cheap DB/WASM detectors — no USDA/UPC network. Keys mirror the
// canonical `problemsCount.byType` names (a Pick of them) so the Maintenance row
// and the Problems section read the same field — no third naming convention.
export const maintenanceCountsSchema = z.object({
  staleIngredientParses: z.number().int(),
  inventoryWithStaleValuations: z.number().int(),
  productsWithNoImages: z.number().int(),
  productsWithWrongCategory: z.number().int(),
  locationsWithoutAiDescription: z.number().int(),
});
export type MaintenanceCounts = z.infer<typeof maintenanceCountsSchema>;
