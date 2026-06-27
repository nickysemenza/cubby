import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";
import { ingredientId } from "./identifiers";
import { ingredientOut, mergeSummary } from "./ingredient";
import { productWithMappingsOut } from "./product-responses";
import { baseKind } from "./problems";
import {
  recipeRefOut,
  recipeTopLevel,
  recipeUsageOut,
} from "./recipe-responses";
import { recomputeSummary } from "./recipe-shared";

export const productWithMappingsAndFoodOut = productWithMappingsOut.extend({
  food: foodSummary.nullable(),
});
export type ProductWithMappingsAndFoodOut = z.infer<
  typeof productWithMappingsAndFoodOut
>;

export const ingredientWithRecipesAndProductOut = ingredientOut.extend({
  recipe: recipeTopLevel.nullable(),
  recipeUsages: z.array(recipeUsageOut),
  appearsInRecipes: z.array(recipeTopLevel),
  product: z.array(productWithMappingsOut),
});
export type IngredientWithRecipesAndProductOut = z.infer<
  typeof ingredientWithRecipesAndProductOut
>;

export const ingredientWithFoodOut = ingredientWithRecipesAndProductOut.extend({
  product: z.array(productWithMappingsAndFoodOut),
});
export type IngredientWithFoodOut = z.infer<typeof ingredientWithFoodOut>;

export const ingredientWithFoodAndSideEffectsOut = ingredientWithFoodOut.extend(
  {
    sideEffects: recomputeSummary,
  },
);
export type IngredientWithFoodAndSideEffectsOut = z.infer<
  typeof ingredientWithFoodAndSideEffectsOut
>;

export const ingredientMergeOut = ingredientWithFoodAndSideEffectsOut.extend({
  mergeSummary,
});
export type IngredientMergeOut = z.infer<typeof ingredientMergeOut>;

// Lean ingredient+food shape: products (with food) without the per-usage recipe
// bodies that detail responses carry. Used by workbench and costing paths.
export const ingredientWithFoodLeanOut = ingredientOut.extend({
  product: z.array(productWithMappingsAndFoodOut),
});
export type IngredientWithFoodLeanOut = z.infer<
  typeof ingredientWithFoodLeanOut
>;

// The ingredient list row: lean ingredient + DB-only products, plus {id,name}
// refs of recipes it appears in. USDA summaries hydrate separately.
export const ingredientListItemOut = ingredientOut.extend({
  product: z.array(productWithMappingsOut),
  appearsInRecipes: z.array(recipeRefOut),
});
export type IngredientListItem = z.infer<typeof ingredientListItemOut>;

/** The single highest-leverage fix for an ingredient, or "done" when complete. */
export const enrichmentFixKind = z.enum([
  "no-product",
  "link-usda",
  "set-per-item-price",
  "add-purchase-mapping",
  "add-weight-mapping",
  "add-volume-mapping",
  "done",
]);

export const enrichmentRowOut = ingredientWithFoodLeanOut.extend({
  recipeCount: z.number(),
  // Every live recipe using this ingredient is book-sourced. Computed in SQL.
  cookbookOnly: z.boolean(),
  coverage: z.object({
    covered: z.array(baseKind),
    // Kinds graded against (all four minus this ingredient's N/A opt-outs).
    applicable: z.array(baseKind),
    tier: z.enum(["complete", "good", "partial", "none"]),
  }),
  recommendedFix: enrichmentFixKind,
  priceMode: z.enum(["per-each", "package"]),
  mergeCandidates: z.array(
    z.object({
      id: ingredientId,
      name: z.string(),
      // pg_trgm similarity (0-1) to this row.
      similarity: z.number(),
    }),
  ),
});
export type EnrichmentRow = z.infer<typeof enrichmentRowOut>;
