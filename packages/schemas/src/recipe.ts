import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { recipeRelatedFilterFields } from "./related-view";
import {
  auditDateFilterFields,
  deriveUpdateFields,
  numericRangeFields,
  timestampedFields,
} from "./base-entity";
import { mutationSideEffectsSchema } from "./background-jobs";
import { generatedCookbookFieldSchemas } from "./generated/entity-field-schemas.cookbook.gen";
import {
  generatedRecipeFieldSchemas,
  generatedRecipeFilterFields,
} from "./generated/entity-field-schemas.recipe.gen";
import { amount } from "./codec";
import { requiredName } from "./common";
import {
  cookbookShortcode,
  ingredientShortcode,
  recipeShortcode,
} from "./identifiers";
import { displayImagesField } from "./display-images";
import { imageUrlSummary } from "./image-summary";
import {
  createPaginatedResponseSchema,
  entityFilterList,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import {
  recipeTopLevelFields,
  recipeTopLevel,
  recipeMeta,
  recipeNotes,
  recipeServings,
  recipeSourceValues,
  recipeTags,
  recipeTotals,
  recipeYieldSchema,
} from "./recipe-shared";
import {
  recipeIngredientInput,
  recipeSectionInput,
  recipeSectionsOut,
} from "./recipe-fields";
export {
  recipeIngredientInput,
  recipeInstructionInput,
  recipeSectionInput,
  recipeSectionsInput,
} from "./recipe-fields";

export * from "./recipe-shared";

export type RecipeSortField = GeneratedEntitySortField<"recipe">;

// The section-ingredient's ingredient carries its aliases so the editor can tell
// real parser drift from a re-parse that just hit one of this ingredient's
// aliases (e.g. "large eggs" → the "large brown eggs" ingredient that aliases it).
const sectionIngredientRefFields = {
  name: z.string(),
  ...timestampedFields,
  aliases: z.array(z.string()).optional(),
};

const sectionIngredientIngredientOut = z.object({
  id: ingredientShortcode,
  ...sectionIngredientRefFields,
});

export const recipeRefOut = z.object({ id: recipeShortcode, name: z.string() });
export type RecipeRef = z.infer<typeof recipeRefOut>;

// One row per RecipeSectionIngredient — the same recipe repeats when it uses the
// ingredient in multiple sections. Carries the per-usage provenance (raw imported
// line, parser-derived modifier) and amounts so ingredient/product detail pages
// can show usage and surface parser drift.
export const recipeUsageOut = z.object({
  id: z.uuid(),
  recipe: recipeTopLevel,
  sectionName: z.string().nullish(),
  amounts: z.array(amount),
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
});
export type RecipeUsage = z.infer<typeof recipeUsageOut>;

/** Public entity-tool projection; the usage row has no public shortcode. */
export const recipeUsageMcpEntityOut = recipeUsageOut.omit({ id: true });

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

export const sectionLineFields = {
  // Declared exception: a recipe section/line id has no shortcode.
  id: z.uuid(),
  amounts: z.array(amount),
  // Provenance from import: the original unparsed line and the parser-derived
  // modifier. Null for rows created before capture, or manual/UI edits.
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
  ...timestampedFields,
};

const ingredientSectionLineOut = z.object({
  ...sectionLineFields,
  type: z.literal("ingredient"),
  recipe: z.null(),
  ingredient: sectionIngredientIngredientOut,
});

const recipeSectionLineOut = z.object({
  ...sectionLineFields,
  type: z.literal("recipe"),
  recipe: recipeTopLevel,
  ingredient: z.null(),
});

export const sectionIngredientOut = z.discriminatedUnion("type", [
  ingredientSectionLineOut,
  recipeSectionLineOut,
]);

/** Public entity-tool projection; section-line rows have no public shortcode. */
export const sectionIngredientMcpEntityOut = z.discriminatedUnion("type", [
  ingredientSectionLineOut.omit({ id: true }),
  recipeSectionLineOut.omit({ id: true }),
]);

export type SectionIngredient = z.infer<typeof sectionIngredientOut>;

export const recipeSectionFields = {
  // Declared exception: section ids have no shortcode.
  id: z.uuid(),
  name: z.string().nullable(),
  instructions: z.array(z.object({ instruction: z.string() })),
  ...timestampedFields,
};

export const recipeSectionOut = z.object({
  ...recipeSectionFields,
  ingredients: z.array(sectionIngredientOut),
});

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

export const recipeOutFields = {
  ...generatedRecipeFieldSchemas.read,
  sections: recipeSectionsOut,
};

export const recipeOut = z.object(recipeOutFields);

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
export const recipeListItemOut = z.object({
  ...recipeTopLevelFields,
  dataQuality: generatedRecipeFieldSchemas.read.dataQuality,
  totals: recipeTotals.nullish(),
  // Live MealRecipe rows under a live Meal — a soft-deleted Meal's plan
  // doesn't count. Backs the list's "Meals" column.
  meals: z.number().int(),
  /** Live sections. Cheap correlated scalar — the section GRAPH is not on the
   *  list path (dropping it was the ~4.7s over-fetch fix). */
  sectionCount: z.number().int(),
  // The list only ever renders a thumbnail, so the section graph AND the full
  // image projection stay off this path (loading every image was the same
  // over-fetch the `totals` comment above dropped `.sections` for).
  displayImages: displayImagesField,
});
export type RecipeListItem = z.infer<typeof recipeListItemOut>;

export type RecipeOut = z.infer<typeof recipeOut>;

export const recipeTagsOut = z.array(z.string());

export const recipeRecomputeAllOut = z.object({
  processed: z.number().int().nonnegative(),
});

export const recipeRecomputeDurableEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("done"), result: z.unknown() }),
]);

export const recipeDryRunRecomputeTotalsOut = z.object({
  wouldChange: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const cookbookSummary = z.object({
  ...generatedCookbookFieldSchemas.read,
  displayImages: displayImagesField,
});
export type CookbookSummary = z.infer<typeof cookbookSummary>;

export type SectionIngredientType = z.infer<
  typeof sectionIngredientOut
>["type"];

export type RecipeIngredientInput = z.infer<typeof recipeIngredientInput>;

export const recipeFilterFields = {
  ...auditDateFilterFields,
  ...recipeRelatedFilterFields,
  ...generatedRecipeFilterFields,
  cookbookId: entityFilterList(cookbookShortcode).optional(),
  cookbookPresenceFilter: presenceFilter,
  /**
   * `recipe.tags` is a nullable array, so `"none"` means untagged —
   * `tags IS NULL OR cardinality(tags) = 0`. A cleared-to-`{}` recipe is just
   * as untagged as a never-tagged one, and both must match. OR-ed with
   * `tagFilters` (see `taskFilterFields.projectPresenceFilter`).
   */
  tagsPresenceFilter: presenceFilter,
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
  /**
   * The recipe's provenance. Nullable, so `sourceTypePresenceFilter: "none"`
   * matches legacy hand-entered rows — and those must stay visible, which is
   * why an exclusion is spelled as a positive list plus this sentinel rather
   * than a `!=` that would evaluate UNKNOWN against NULL and drop them.
   */
  sourceTypeFilter: oneOrMany(z.enum(recipeSourceValues)).optional(),
  sourceTypePresenceFilter: presenceFilter,
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

// Descriptions surface to MCP clients through the explicit `mcpRecipe*Fields`
// exports below; keep create-required fields and update-optional fields separate.
const recipeWritableFields = {
  name: requiredName("Recipe name").describe("Recipe name"),
  meta: recipeMeta.describe("Source metadata, e.g. { url } of the web source"),
  yield: recipeYieldSchema
    .nullable()
    .optional()
    .describe('What the recipe produces, e.g. { value: 2, unit: "loaves" }'),
  servings: recipeServings
    .nullable()
    .optional()
    .describe("Number of servings (positive integer)"),
  tags: recipeTags.nullable().optional().describe("Free-form tags"),
  notes: recipeNotes
    .nullable()
    .optional()
    .describe("Freeform markdown headnote/intro plus tips"),
  sections: z
    .array(recipeSectionInput)
    .describe(
      "Recipe sections, each with ingredients (by ingredient/recipe id) and instructions",
    ),
};

export const recipeCreateInput = z.object(generatedRecipeFieldSchemas.create);

export const recipeUpdateData = z
  .object(generatedRecipeFieldSchemas.update)
  .partial();

export const recipeUpdateInput = z.object({
  id: recipeShortcode,
  data: recipeUpdateData,
});

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

export type RecipeCreateInput = z.infer<typeof recipeCreateInput>;
export type RecipeUpdateInput = z.infer<typeof recipeUpdateInput>;

export const mcpRecipeCreateInput = z.object(recipeWritableFields);
const mcpRecipeUpdateFields = {
  id: recipeShortcode.describe("Recipe ID"),
  ...deriveUpdateFields(recipeWritableFields),
};
export const mcpRecipeUpdateInput = z.object(mcpRecipeUpdateFields);

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
  // to a uuid (find_recipes_using_ingredient never needs the private id).
  ingredientId: ingredientShortcode,
  count: z.number().int().nonnegative(),
  recipes: z.array(recipeWithUsagesMcpOut),
});

export const recipeIdOut = z.object({ id: recipeShortcode });
