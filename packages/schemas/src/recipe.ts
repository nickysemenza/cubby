import {
  recipeOut,
  recipeFilterFields as recipeBaseFilterFields,
} from "@cubby/schemas/entities/recipe";

import { recipeFieldEnvelopeSchemas } from "./generated/entity-field-envelopes.recipe.gen";
import {
  recipeFieldEnvelopeFields,
  recipePublicReadFields,
} from "./generated/entity-field-envelope-fields.recipe.gen";
import { rawRecipeGraph } from "./recipe-raw-read";
import { withFieldEnvelopes } from "./field-envelope";

import { z } from "zod";
import { batchProgressEvent } from "./batch";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { auditDateFilterFields, numericRangeFields } from "./base-entity";
import { mutationSideEffectsSchema } from "./mutation-side-effects";
import {
  generatedCookbookFieldSchemas,
  generatedCookbookFilterFields,
} from "./generated/entity-field-schemas.cookbook.gen";
import { amount } from "./codec";
import {
  cookbookShortcode,
  ingredientShortcode,
  recipeShortcode,
} from "./identifiers";
import { presenceFilter } from "./pagination";
import { rawRecipeTopLevel, recipeRefOut } from "./recipe-shared";
import { recipeIngredientInput } from "./recipe-fields";
export { sectionLineFields, recipeSectionFields } from "./recipe-fields";

export {
  recipeIngredientInput,
  recipeInstructionInput,
  recipeLineAsInput,
  type RecipeSectionLineRead,
  recipeSectionInput,
  recipeSectionsInput,
} from "./recipe-fields";

export * from "./recipe-shared";

export type RecipeSortField = GeneratedEntitySortField<"recipe">;

export type RecipeRef = z.infer<typeof recipeRefOut>;
export const recipeTopLevel = withFieldEnvelopes(
  rawRecipeTopLevel,
  recipeFieldEnvelopeFields,
  recipePublicReadFields,
);
export type RecipeTopLevel = z.output<typeof recipeTopLevel>;

// One row per RecipeSectionIngredient — the same recipe repeats when it uses the
// ingredient in multiple sections. Carries the per-usage provenance (raw imported
// line, parser-derived modifier) and amounts so ingredient/product detail pages
// can show usage and surface parser drift.
export {
  recipeUsageOut,
  recipeUsageMcpEntityOut,
  type RecipeUsage,
} from "./recipe-fields";
export const recipeSectionOut =
  recipeFieldEnvelopeSchemas.output.shape.sections.element;
export const sectionIngredientOut = recipeSectionOut.shape.ingredients.element;
export const recipeSectionMcpEntityOut =
  recipeFieldEnvelopeSchemas.mcpOutput.shape.sections.element;
export const sectionIngredientMcpEntityOut =
  recipeSectionMcpEntityOut.shape.ingredients.element;

export type SectionIngredient = z.infer<typeof sectionIngredientOut>;

export type SectionIngredientOut = z.infer<typeof sectionIngredientOut>;
export type RecipeSectionOut = z.infer<typeof recipeSectionOut>;

export const recipeGraphOut = withFieldEnvelopes(
  rawRecipeGraph,
  recipeFieldEnvelopeFields,
  recipePublicReadFields,
).extend({ sections: recipeFieldEnvelopeSchemas.output.shape.sections });
export type RecipeGraphOut = z.output<typeof recipeGraphOut>;

export const recipeWithSideEffectsOut = recipeOut.extend({
  sideEffects: mutationSideEffectsSchema,
});

export const recipeGraphListOut = z.array(recipeGraphOut);

// Summary shape for `recipe.list`: scalar fields + persisted totals, no section
// graph (the list/pickers never read `.sections` — that was the ~4.7s over-fetch).

export const recipeTagsOut = z.array(z.string());

export const recipeRecomputeAllOut = z.object({
  processed: z.number().int().nonnegative(),
});

export const recipeRecomputeDurableEventSchema = z.discriminatedUnion("type", [
  batchProgressEvent,
  z.object({ type: z.literal("done"), result: z.unknown() }),
]);

export const recipeDryRunRecomputeTotalsOut = z.object({
  wouldChange: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const cookbookFilterFields = {
  ...auditDateFilterFields,
  ...generatedCookbookFilterFields,
};
export type CookbookFilters = z.infer<z.ZodObject<typeof cookbookFilterFields>>;

export const cookbookUpdateInput = z.object(
  generatedCookbookFieldSchemas.update,
);
export type CookbookUpdateInput = z.infer<typeof cookbookUpdateInput>;

export type SectionIngredientType = z.infer<
  typeof sectionIngredientOut
>["type"];

export type RecipeIngredientInput = z.infer<typeof recipeIngredientInput>;

export const recipeFilterFields = {
  ...recipeBaseFilterFields,
  /**
   * `"none"` is the never-planned worklist. A live MealRecipe under a
   * soft-deleted Meal doesn't count — that isn't a plan.
   */
  mealPresenceFilter: presenceFilter.describe(
    "Filter to recipes that have / haven't been planned on at least one live meal",
  ),
  imagePresenceFilter: presenceFilter.describe(
    "Filter to recipes that do / don't have at least one image (PDFs don't count)",
  ),
  /**
   * `"none"` is the can't-cook-from-it worklist: no live section carries a
   * non-empty instruction list. Counts SECTIONS, not recipes — a recipe whose
   * sections all have empty instruction arrays still has none.
   */
  instructionsPresenceFilter: presenceFilter.describe(
    "Filter to recipes that do / don't have any written instructions.",
  ),
  ...numericRangeFields("costTotal", { nonnegative: true }),
  ...numericRangeFields("caloriesTotal", { nonnegative: true }),
  // Total elapsed time in minutes — a real column, so this is a plain SQL
  // range. A recipe whose source printed no total time (or printed prose no
  // parser would commit to) has NULL here and matches neither bound.
};

export const recipeFiltersSchema = z.object(recipeFilterFields);

/** MCP list_recipes filters — name substring only. */
export const recipeListFilterFields = {
  nameFilter: recipeFilterFields.nameFilter,
};

export const recipeShortcodeInput = z.object({
  shortcode: recipeShortcode,
});

export const recipeIdsInput = z.object({
  ids: z.array(recipeShortcode),
});

export const recipeCooccurrenceInput = z
  .object({
    minEdgeWeight: z.number().min(1).default(2),
  })
  .optional();

export const recipeCookbookScopeInput = z
  .object({
    cookbookId: cookbookShortcode.optional(),
  })
  .optional();

export const recipeIdInput = z.object({
  id: recipeShortcode,
});

export const recipeUsageMcpOut = z.object({
  // RecipeSectionIngredient row id — declared exception. Recipe section/line
  // ids have no shortcode and stay uuid across the MCP boundary.
  lineId: z.uuid(),
  sectionName: z.string().nullable(),
  amounts: z.array(amount),
  rawLine: z.string().nullable(),
  modifier: z.string().nullable(),
});

const recipeWithUsagesMcpOut = recipeRefOut.extend({
  usages: z.array(recipeUsageMcpOut),
});

export const recipesUsingIngredientOut = z.object({
  // The ingredient shortcode the caller passed in — echoed back, not resolved
  // to a uuid (recipe_insights.recipe_usages never needs the private id).
  ingredientId: ingredientShortcode,
  count: z.number().int().nonnegative(),
  recipes: z.array(recipeWithUsagesMcpOut),
});

export const recipeIdOut = z.object({ id: recipeShortcode });
