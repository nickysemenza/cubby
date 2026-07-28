import { z } from "zod";
import {
  deriveUpdateData,
  deriveUpdateFields,
  timestampedFields,
} from "./base-entity";
import { mutationSideEffectsSchema } from "./background-jobs";
import { amount, positiveAmount } from "./codec";
import { requiredName } from "./common";
import {
  cookbookId,
  id,
  ingredientId,
  normalizedRecipeShortcode,
  recipeId,
} from "./identifiers";
import { imageOut } from "./image";
import {
  createItemsResponseSchema,
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import {
  recipeMeta,
  recipeNotes,
  recipeServings,
  recipeSource,
  recipeTags,
  recipeTotals,
  recipeYieldSchema,
} from "./recipe-shared";

export * from "./recipe-shared";

export const recipeSortableFields = [
  "createdAt",
  "name",
  // Joined cookbook name — resolved by a correlated subquery in repo/recipe.
  "cookbook",
  "costTotal",
  "caloriesTotal",
  "source",
  "yield",
  "tags",
] as const;

export type RecipeSortField = (typeof recipeSortableFields)[number];

// The section-ingredient's ingredient carries its aliases so the editor can tell
// real parser drift from a re-parse that just hit one of this ingredient's
// aliases (e.g. "large eggs" → the "large brown eggs" ingredient that aliases it).
const sectionIngredientIngredientOut = z.object({
  id: ingredientId,
  name: z.string(),
  ...timestampedFields,
  aliases: z.array(z.string()).optional(),
});

const recipeTopLevelFields = {
  id: recipeId,
  name: z.string(),
  ...timestampedFields,
  meta: recipeMeta,
  // Strong provenance, derived from the DB columns on read. Output-only for now
  // (`meta.url` still drives the write path); nullish so older rows are lenient.
  source: recipeSource.nullish(),
  yield: recipeYieldSchema.nullish(),
  servings: recipeServings.nullish(),
  tags: recipeTags.nullish(),
  notes: recipeNotes.nullish(),
};

export const recipeTopLevel = z.object(recipeTopLevelFields);
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

// Create a discriminated union to ensure either recipe or ingredient is set
export const sectionIngredientOut = z.discriminatedUnion("type", [
  z.object({
    id: z.uuid(),
    amounts: z.array(amount),
    // Provenance from import: the original unparsed line and the parser-derived
    // modifier. Null for rows created before capture, or manual/UI edits.
    rawLine: z.string().nullish(),
    modifier: z.string().nullish(),
    ...timestampedFields,
    type: z.literal("ingredient"),
    recipe: z.null(),
    ingredient: sectionIngredientIngredientOut,
  }),
  z.object({
    id: z.uuid(),
    amounts: z.array(amount),
    // Provenance from import: the original unparsed line and the parser-derived
    // modifier. Null for rows created before capture, or manual/UI edits.
    rawLine: z.string().nullish(),
    modifier: z.string().nullish(),
    ...timestampedFields,
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
  ...timestampedFields,
});

export type SectionIngredientOut = z.infer<typeof sectionIngredientOut>;
export type RecipeSectionOut = z.infer<typeof recipeSectionOut>;

export const recipeGraphOut = z.object({
  ...recipeTopLevelFields,
  sections: z.array(recipeSectionOut),
  // Precomputed cost/calorie rollup (null until first computed). Populated by
  // recipe.list; getByID may leave it null (the detail page computes its own).
  totals: recipeTotals.nullish(),
});
export type RecipeGraphOut = z.infer<typeof recipeGraphOut>;

const recipeOutFields = {
  ...recipeTopLevelFields,
  sections: z.array(recipeSectionOut),
  // Precomputed cost/calorie rollup (null until first computed). Populated by
  // recipe.list; getByID may leave it null (the detail page computes its own).
  totals: recipeTotals.nullish(),
  images: z.array(imageOut),
};

export const recipeOut = z.object(recipeOutFields);

export const recipeWithSideEffectsOut = z.object({
  ...recipeOutFields,
  sideEffects: mutationSideEffectsSchema,
});

// Full recipe graph without media. Used by costing/sub-recipe closure fetches
// that need sections but deliberately do not load images.
export const recipeGraphListOut = z.array(recipeGraphOut);

// Summary shape for `recipe.list`: scalar fields + persisted totals, no section
// graph (the list/pickers never read `.sections` — that was the ~4.7s over-fetch).
export const recipeListItemOut = z.object({
  ...recipeTopLevelFields,
  totals: recipeTotals.nullish(),
});
export type RecipeListItem = z.infer<typeof recipeListItemOut>;

export type RecipeOut = z.infer<typeof recipeOut>;

export const recipeTagsOut = z.array(z.string());

export const recipeRecomputeAllOut = z.object({
  processed: z.number().int().nonnegative(),
});

export const recipeDryRunRecomputeTotalsOut = z.object({
  wouldChange: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
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

// Schema for recipe mutations
// Raw, unparsed source line + the parser-derived modifier (e.g. "finely
// chopped"). Optional provenance carried through from import so it can be
// persisted on RecipeSectionIngredient; absent on manual/UI edits.
const ingredientProvenance = {
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
};

export const recipeIngredientInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ingredient"),
    ingredientId: ingredientId,
    recipeId: z.null(),
    amounts: z.array(positiveAmount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
  z.object({
    type: z.literal("recipe"),
    recipeId: recipeId,
    ingredientId: z.null(),
    amounts: z.array(positiveAmount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
]);
export type RecipeIngredientInput = z.infer<typeof recipeIngredientInput>;

export const recipeInstructionInput = z.object({
  instruction: z.string(),
  id: id.optional(),
});

export const recipeSectionInput = z.object({
  name: z.string().min(2).nullable().optional(),
  ingredients: z.array(recipeIngredientInput).min(1).optional(),
  instructions: z.array(recipeInstructionInput).min(1).optional(),
  id: id.optional(),
});

// Descriptions live at the field level here (rather than on the shared building
// blocks, which are also reused by the output/form layers) so they reliably
// Filters accepted by the recipe list endpoint.
export const recipeFilterFields = {
  nameFilter: z.string().optional(),
  tagFilters: z.array(z.string()).optional(),
  cookbookId: oneOrMany(cookbookId).optional(),
  /**
   * `"none"` matches recipes with no cookbook; `"has"` matches those with
   * any cookbook. Combined with `cookbookId` it **widens** rather than
   * narrows, same OR semantics as `taskFilterFields.projectPresenceFilter`.
   */
  cookbookPresenceFilter: presenceFilter,
  /**
   * `recipe.tags` is a nullable array, so `"none"` means untagged —
   * `tags IS NULL OR cardinality(tags) = 0`. A cleared-to-`{}` recipe is just
   * as untagged as a never-tagged one, and both must match. OR-ed with
   * `tagFilters` (see `taskFilterFields.projectPresenceFilter`).
   */
  tagsPresenceFilter: presenceFilter,
};

export const recipeFiltersSchema = z.object(recipeFilterFields);

/** MCP list_recipes filters — name substring only. */
export const recipeListFilterFields = {
  nameFilter: recipeFilterFields.nameFilter,
};

// Descriptions surface to MCP clients through the explicit `mcpRecipe*Shape`
// exports below; keep create-required fields and update-optional fields separate.
const recipeWritableShape = {
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

const recipeCreateShape = {
  ...recipeWritableShape,
  pendingImageIds: z.array(z.uuid()).optional(),
};
export const recipeCreateInput = z.object(recipeCreateShape);

export const recipeUpdateData = deriveUpdateData(recipeCreateShape, {
  extend: {
    removeImageIds: z.array(z.uuid()).optional(),
    imageOrder: z
      .array(z.uuid())
      .optional()
      .describe("existing image ids in display order; first = cover"),
  },
});

export const recipeUpdateInput = z.object({
  id: recipeId,
  data: recipeUpdateData,
});

export const recipeShortcodeInput = z.object({
  shortcode: normalizedRecipeShortcode,
});

export const recipeIdsInput = z.object({
  ids: z.array(recipeId),
});

export const recipeCooccurrenceInput = z
  .object({
    minEdgeWeight: z.number().min(1).default(2),
  })
  .optional();

export const recipeCookbookScopeInput = z
  .object({
    cookbookId: cookbookId.optional(),
  })
  .optional();

export const recipeIdInput = z.object({
  id: recipeId,
});

export type RecipeCreateInput = z.infer<typeof recipeCreateInput>;
export type RecipeUpdateInput = z.infer<typeof recipeUpdateInput>;

export const mcpRecipeCreateInput = z.object(recipeWritableShape);
const mcpRecipeUpdateFields = {
  id: recipeId.describe("Recipe ID"),
  ...deriveUpdateFields(recipeWritableShape),
};
export const mcpRecipeUpdateInput = z.object(mcpRecipeUpdateFields);

/** Slim MCP projection of a recipe list row. */
export const recipeMcpOut = z.object({
  id: recipeId,
  name: z.string(),
  yield: recipeYieldSchema.nullish(),
  servings: recipeServings.nullish(),
  tags: recipeTags.nullish(),
  shortcode: normalizedRecipeShortcode.nullish(),
});
export type RecipeMcpOut = z.infer<typeof recipeMcpOut>;

export const recipeMcpListOut = createPaginatedResponseSchema(recipeMcpOut);

export const recipeUsageMcpOut = z.object({
  lineId: z.uuid(),
  sectionName: z.string().nullable(),
  amounts: z.array(amount),
  rawLine: z.string().nullable(),
  modifier: z.string().nullable(),
});

const recipeWithUsagesMcpFields = {
  id: recipeId,
  name: z.string(),
  yield: recipeYieldSchema.nullish(),
  servings: recipeServings.nullish(),
  tags: recipeTags.nullish(),
  shortcode: normalizedRecipeShortcode.nullish(),
  usages: z.array(recipeUsageMcpOut),
};

export const recipesUsingIngredientOut = z.object({
  ingredientId: ingredientId,
  count: z.number().int().nonnegative(),
  recipes: z.array(z.object(recipeWithUsagesMcpFields)),
});

export const recipeIdOut = z.object({ id: recipeId });

export const recipeTagsListOut = createItemsResponseSchema(z.string());

export const cookbookSummariesMcpOut =
  createItemsResponseSchema(cookbookSummary);

export const recipeRecomputeMcpOut = z.object({
  processed: z.number().int().nonnegative(),
});
