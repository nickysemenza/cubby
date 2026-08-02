import { z } from "zod";
import { recipeRelatedFilterFields } from "./related-view";
import {
  auditDateFilterFields,
  deriveUpdateData,
  deriveUpdateFields,
  timestampedFields,
} from "./base-entity";
import { mutationSideEffectsSchema } from "./background-jobs";
import { amount, positiveAmount } from "./codec";
import { requiredName } from "./common";
import {
  cookbookShortcode,
  id,
  ingredientShortcode,
  recipeShortcode,
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
  "updatedAt",
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
/** The ingredient a recipe line points at, keyed by its public id. */
const sectionIngredientRefFields = {
  name: z.string(),
  ...timestampedFields,
  aliases: z.array(z.string()).optional(),
};

const sectionIngredientIngredientOut = z.object({
  id: ingredientShortcode,
  ...sectionIngredientRefFields,
});

export const recipeTopLevelFields = {
  id: recipeShortcode,
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
export const recipeRefOut = z.object({ id: recipeShortcode, name: z.string() });
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
/** Fields every section line shares, whichever arm it is. */
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

export const sectionIngredientOut = z.discriminatedUnion("type", [
  z.object({
    ...sectionLineFields,
    type: z.literal("ingredient"),
    recipe: z.null(),
    ingredient: sectionIngredientIngredientOut,
  }),
  z.object({
    ...sectionLineFields,
    type: z.literal("recipe"),
    recipe: recipeTopLevel,
    ingredient: z.null(),
  }),
]);

export type SectionIngredient = z.infer<typeof sectionIngredientOut>;

/** Section fields minus `ingredients`, which differs between UI and MCP. */
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

export const recipeOutFields = {
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
  // Live MealRecipe rows under a live Meal — a soft-deleted Meal's plan
  // doesn't count. Backs the list's "Meals" column.
  mealCount: z.number().int(),
  // Single cover image only (sortOrder-first, limit 1) — the list only ever
  // renders a thumbnail, and loading every image was the over-fetch the
  // `totals` comment above already dropped `.sections` for. Backs the
  // standard image column (createImageColumn).
  images: z.array(imageOut),
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
  id: cookbookShortcode,
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
    ingredientId: ingredientShortcode,
    recipeId: z.null(),
    amounts: z.array(positiveAmount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
  z.object({
    type: z.literal("recipe"),
    recipeId: recipeShortcode,
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
  ...auditDateFilterFields,
  ...recipeRelatedFilterFields,
  nameFilter: z.string().optional(),
  tagFilters: z.array(z.string()).optional(),
  cookbookId: oneOrMany(cookbookShortcode).optional(),
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
  costTotalMin: z.coerce.number().nonnegative().optional(),
  costTotalMax: z.coerce.number().nonnegative().optional(),
  caloriesTotalMin: z.coerce.number().nonnegative().optional(),
  caloriesTotalMax: z.coerce.number().nonnegative().optional(),
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

export const mcpRecipeCreateInput = z.object(recipeWritableShape);
const mcpRecipeUpdateFields = {
  id: recipeShortcode.describe("Recipe ID"),
  ...deriveUpdateFields(recipeWritableShape),
};
export const mcpRecipeUpdateInput = z.object(mcpRecipeUpdateFields);

/** Slim MCP projection of a recipe list row. */
/** The lean recipe MCP surface, as a field map so derived shapes can compose it
 * without reaching into `.shape`. */
export const recipeMcpFields = {
  id: recipeShortcode,
  name: z.string(),
  yield: recipeYieldSchema.nullish(),
  servings: recipeServings.nullish(),
  tags: recipeTags.nullish(),
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

const recipeWithUsagesMcpFields = {
  ...recipeMcpFields,
  usages: z.array(recipeUsageMcpOut),
};

export const recipesUsingIngredientOut = z.object({
  // The ingredient shortcode the caller passed in — echoed back, not resolved
  // to a uuid (find_recipes_using_ingredient never needs the private id).
  ingredientId: ingredientShortcode,
  count: z.number().int().nonnegative(),
  recipes: z.array(z.object(recipeWithUsagesMcpFields)),
});

export const recipeIdOut = z.object({ id: recipeShortcode });

export const recipeTagsListOut = createItemsResponseSchema(z.string());

export const cookbookSummariesMcpOut =
  createItemsResponseSchema(cookbookSummary);

export const recipeRecomputeMcpOut = z.object({
  processed: z.number().int().nonnegative(),
});
