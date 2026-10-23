import cookbookDefinition from "./entity-definitions/03-cookbook.entity";
import recipeDefinition from "./entity-definitions/01-recipe.entity";
import { recipeUsageMcpEntityOut } from "./recipe-fields";
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
import { imageUrlSummary } from "./image-summary";
import { createPaginatedResponseSchema, presenceFilter } from "./pagination";
import {
  recipeTopLevelFields,
  recipeTopLevel,
  recipeTotals,
  recipeRefOut,
} from "./recipe-shared";
import {
  recipeIngredientInput,
  recipeSectionOut,
  ingredientSectionLineOut,
  recipeSectionLineOut,
  recipeSectionIngredientOut as sectionIngredientOut,
} from "./recipe-fields";
export {
  sectionLineFields,
  recipeSectionFields,
  recipeSectionOut,
  recipeSectionIngredientOut as sectionIngredientOut,
} from "./recipe-fields";
import { recipeBaseFilterFields } from "./generated/recipe.gen";

export {
  recipeCreateInput,
  recipeUpdateData,
  recipeUpdateInput,
  type RecipeCreateInput,
  type RecipeUpdateInput,
} from "./generated/recipe.gen";
export {
  recipeIngredientInput,
  recipeInstructionInput,
  recipeLineAsInput,
  recipeSectionInput,
  recipeSectionsInput,
} from "./recipe-fields";

export * from "./recipe-shared";

export type RecipeSortField = GeneratedEntitySortField<"recipe">;

export type RecipeRef = z.infer<typeof recipeRefOut>;

// One row per RecipeSectionIngredient — the same recipe repeats when it uses the
// ingredient in multiple sections. Carries the per-usage provenance (raw imported
// line, parser-derived modifier) and amounts so ingredient/product detail pages
// can show usage and surface parser drift.
export {
  recipeUsageOut,
  recipeUsageMcpEntityOut,
  type RecipeUsage,
} from "./recipe-fields";
/**
 * Recipe reference as embedded in MCP ingredient reads: identity plus the
 * planning-relevant scalars, minus `notes`/`meta`/`source`/timestamps. A
 * cookbook headnote repeats once per usage row, and an ingredient in 45 recipes
 * shipped ~100KB of prose an agent never needs — `entity get recipe` still
 * returns the full recipe.
 */
export const recipeRefMcpEntityOut = recipeTopLevel.pick({
  id: true,
  name: true,
  yield: true,
  servings: true,
  tags: true,
});
export type RecipeRefMcpEntityOut = z.infer<typeof recipeRefMcpEntityOut>;

export const recipeUsageRefMcpEntityOut = recipeUsageMcpEntityOut.extend({
  recipe: recipeRefMcpEntityOut,
});

/** Public entity-tool projection; section-line rows have no public shortcode. */
export const sectionIngredientMcpEntityOut = z.discriminatedUnion("type", [
  ingredientSectionLineOut.omit({ id: true }),
  recipeSectionLineOut.omit({ id: true }),
]);

export type SectionIngredient = z.infer<typeof sectionIngredientOut>;

/** Public entity-tool projection; section rows have no public shortcode. */
export const recipeSectionMcpEntityOut = recipeSectionOut
  .omit({ id: true, ingredients: true })
  .extend({ ingredients: z.array(sectionIngredientMcpEntityOut) });

export type SectionIngredientOut = z.infer<typeof sectionIngredientOut>;
export type RecipeSectionOut = z.infer<typeof recipeSectionOut>;

export const recipeGraphOut = z.object({
  ...recipeTopLevelFields,
  sections: z.array(recipeSectionOut),
  displayImage: imageUrlSummary.nullable(),
  totals: recipeTotals.nullish(),
});
export type RecipeGraphOut = z.infer<typeof recipeGraphOut>;

export const recipeOutFields = recipeDefinition.readSchemas.output.shape;

export const recipeOut = recipeDefinition.readSchemas.output;

/** Full recipe output with storage-only section and line identifiers removed. */
export const recipeMcpEntityOut = recipeOut.extend({
  sections: z.array(recipeSectionMcpEntityOut),
});

export const recipeWithSideEffectsOut = z.object({
  ...recipeOutFields,
  sideEffects: mutationSideEffectsSchema,
});

export const recipeGraphListOut = z.array(recipeGraphOut);

// Summary shape for `recipe.list`: scalar fields + persisted totals, no section
// graph (the list/pickers never read `.sections` — that was the ~4.7s over-fetch).
export const recipeListItemOut = recipeDefinition.readSchemas.list;
export type RecipeListItem = z.infer<typeof recipeListItemOut>;

export type RecipeOut = z.infer<typeof recipeOut>;

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

export const cookbookSummary = cookbookDefinition.readSchemas.output;
export type CookbookSummary = z.infer<typeof cookbookSummary>;

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

/**
 * Slim MCP projection of a recipe list row — built from the same field map as
 * `recipeOut`, so it cannot drift from the plain shape. `recipeMcpFields` is
 * shared with `recipeWithUsagesMcpOut` below, so that shape stays in sync too.
 */
const recipeMcpFields = {
  id: recipeOutFields.id,
  name: recipeOutFields.name,
  yield: recipeOutFields.yield,
  servings: recipeOutFields.servings,
  tags: recipeOutFields.tags,
};

export const recipeMcpOut = z.object(recipeMcpFields);
export type RecipeMcpOut = z.infer<typeof recipeMcpOut>;

export const recipeMcpListOut = createPaginatedResponseSchema(recipeMcpOut);

export const recipeUsageMcpOut = z.object({
  // RecipeSectionIngredient row id — declared exception. Recipe section/line
  // ids have no shortcode and stay uuid across the MCP boundary.
  lineId: z.uuid(),
  sectionName: z.string().nullable(),
  amounts: z.array(amount),
  rawLine: z.string().nullable(),
  modifier: z.string().nullable(),
});

const recipeWithUsagesMcpOut = z.object({
  ...recipeMcpFields,
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
