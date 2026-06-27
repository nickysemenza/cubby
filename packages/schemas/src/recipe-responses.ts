import { z } from "zod";
import { amount } from "./codec";
import { baseEntitySchema } from "./common";
import { cookbookId, ingredientId, recipeId } from "./identifiers";
import { imageOut } from "./image-responses";
import {
  recipeMeta,
  recipeNotes,
  recipeServings,
  recipeSource,
  recipeTags,
  recipeTotals,
  recipeYieldSchema,
} from "./recipe-shared";

// The section-ingredient's ingredient carries its aliases so the editor can tell
// real parser drift from a re-parse that just hit one of this ingredient's
// aliases (e.g. "large eggs" → the "large brown eggs" ingredient that aliases it).
const ingredientOut = baseEntitySchema.extend({
  id: ingredientId,
  aliases: z.array(z.string()).optional(),
});

export const recipeTopLevel = baseEntitySchema.extend({
  id: recipeId,
  meta: recipeMeta,
  // Strong provenance, derived from the DB columns on read. Output-only for now
  // (`meta.url` still drives the write path); nullish so older rows are lenient.
  source: recipeSource.nullish(),
  yield: recipeYieldSchema.nullish(),
  servings: recipeServings.nullish(),
  tags: recipeTags.nullish(),
  notes: recipeNotes.nullish(),
});
export type RecipeTopLevel = z.infer<typeof recipeTopLevel>;

// Minimal recipe reference — just enough to link + label a recipe pill. Lets
// list surfaces carry "appears in recipes" without the full recipe body per row
// (the over-fetch the ingredient list paid via `appearsInRecipes: recipeTopLevel[]`).
export const recipeRefOut = z.object({ id: recipeId, name: z.string() });
export type RecipeRef = z.infer<typeof recipeRefOut>;

// One row per RecipeSectionIngredient — the same recipe repeats when it uses the
// ingredient in multiple sections. Carries the per-usage provenance (raw imported
// line, parser-derived modifier) and amounts so ingredient/product detail pages
// can show usage and surface parser drift.
export const recipeUsageOut = z.object({
  // RecipeSectionIngredient id — stable row identity (a recipe can appear twice).
  id: z.uuid(),
  recipe: recipeTopLevel,
  sectionName: z.string().nullish(),
  amounts: z.array(amount),
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
});
export type RecipeUsage = z.infer<typeof recipeUsageOut>;

// Create a base schema with common fields
const sectionIngredientBaseOut = z.object({
  id: z.uuid(),
  amounts: z.array(amount),
  // Provenance from import: the original unparsed line and the parser-derived
  // modifier. Null for rows created before capture, or manual/UI edits.
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Create a discriminated union to ensure either recipe or ingredient is set
export const sectionIngredientOut = z.discriminatedUnion("type", [
  sectionIngredientBaseOut.extend({
    type: z.literal("ingredient"),
    recipe: z.null(),
    ingredient: ingredientOut,
  }),
  sectionIngredientBaseOut.extend({
    type: z.literal("recipe"),
    recipe: recipeTopLevel,
    ingredient: z.null(),
  }),
]);

export type SectionIngredient = z.infer<typeof sectionIngredientOut>;

export const recipeSectionOut = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  ingredients: z.array(sectionIngredientOut),
  instructions: z.array(z.object({ instruction: z.string() })),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type SectionIngredientOut = z.infer<typeof sectionIngredientOut>;
export type RecipeSectionOut = z.infer<typeof recipeSectionOut>;

export const recipeWithSectionsOut = recipeTopLevel.extend({
  sections: z.array(recipeSectionOut),
  // Precomputed cost/calorie rollup (null until first computed). Populated by
  // recipe.list; getByID may leave it null (the detail page computes its own).
  totals: recipeTotals.nullish(),
});
export type RecipeWithSectionsOut = z.infer<typeof recipeWithSectionsOut>;

export const recipeOut = recipeWithSectionsOut.extend({
  images: z.array(imageOut),
});

// Full recipe graph without media. Used by costing/sub-recipe closure fetches
// that need sections but deliberately do not load images.
export const recipeGraphOut = recipeWithSectionsOut;
export type RecipeGraphOut = z.infer<typeof recipeGraphOut>;

export const recipeGraphListOut = z.array(recipeGraphOut);

// Summary shape for `recipe.list`: scalar fields + persisted totals, no section
// graph (the list/pickers never read `.sections` — that was the ~4.7s over-fetch).
export const recipeListItemOut = recipeTopLevel.extend({
  totals: recipeTotals.nullish(),
});
export type RecipeListItem = z.infer<typeof recipeListItemOut>;

export type RecipeOut = z.infer<typeof recipeOut>;

export const recipeTagsOut = z.array(z.string());

export const recipeRecomputeAllOut = z.object({
  processed: z.number().int(),
});

export const recipeDryRunRecomputeTotalsOut = z.object({
  wouldChange: z.number().int(),
  total: z.number().int(),
});

// A cookbook as seen on the browse index: the `Cookbook` row plus how many
// non-deleted recipes link to it. `book` is the cookbook name (kept for the
// existing browse-by-name route + UI); `hasRawJson` gates the reprocess action.
export const cookbookSummary = z.object({
  id: cookbookId,
  book: z.string(),
  author: z.array(z.string()),
  subjects: z.array(z.string()),
  recipeCount: z.number().int().nonnegative(),
  // Public URL of the cookbook's cover image, or null. Number of recipes in the
  // stored extraction (rawJson) — `sourceRecipeCount - recipeCount` is how many
  // could still be added from source.
  coverUrl: z.string().nullable(),
  sourceRecipeCount: z.number().int().nonnegative(),
});
export type CookbookSummary = z.infer<typeof cookbookSummary>;

export type SectionIngredientType = z.infer<
  typeof sectionIngredientOut
>["type"];
