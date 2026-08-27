import { z } from "zod";
import { recipeRelatedFilterFields } from "./related-view";
import {
  auditDateFilterFields,
  deriveUpdateData,
  deriveUpdateFields,
  numericRangeFields,
  timestampedFields,
} from "./base-entity";
import { mutationSideEffectsSchema } from "./background-jobs";
import { amount, positiveAmount } from "./codec";
import { requiredName } from "./common";
import {
  cookbookShortcode,
  id,
  imageShortcode,
  ingredientShortcode,
  productShortcode,
  recipeShortcode,
} from "./identifiers";
import { imageOut } from "./image";
import { imageUrlSummary } from "./image-summary";
import {
  createItemsResponseSchema,
  createPaginatedResponseSchema,
  entityFilterList,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import {
  recipeMeta,
  recipeNotes,
  recipeServings,
  recipeSource,
  recipeSourceValues,
  recipeTags,
  recipeTotals,
  recipeYieldSchema,
} from "./recipe-shared";

export * from "./recipe-shared";

export const recipeSortableFields = [
  "createdAt",
  "updatedAt",
  "name",
  "cookbook",
  "costTotal",
  "caloriesTotal",
  "source",
  "yield",
  "tags",
  "totalMinutes",
] as const;

export type RecipeSortField = (typeof recipeSortableFields)[number];

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
  displayImage: imageUrlSummary.nullable(),
  totals: recipeTotals.nullish(),
});
export type RecipeGraphOut = z.infer<typeof recipeGraphOut>;

export const recipeOutFields = {
  ...recipeTopLevelFields,
  sections: z.array(recipeSectionOut),
  totals: recipeTotals.nullish(),
  images: z.array(imageOut),
};

export const recipeOut = z.object(recipeOutFields);

export const recipeWithSideEffectsOut = z.object({
  ...recipeOutFields,
  sideEffects: mutationSideEffectsSchema,
});

export const recipeGraphListOut = z.array(recipeGraphOut);

// Summary shape for `recipe.list`: scalar fields + persisted totals, no section
// graph (the list/pickers never read `.sections` — that was the ~4.7s over-fetch).
export const recipeListItemOut = z.object({
  ...recipeTopLevelFields,
  totals: recipeTotals.nullish(),
  // Live MealRecipe rows under a live Meal — a soft-deleted Meal's plan
  // doesn't count. Backs the list's "Meals" column.
  mealCount: z.number().int(),
  /** Live sections. Cheap correlated scalar — the section GRAPH is not on the
   *  list path (dropping it was the ~4.7s over-fetch fix). */
  sectionCount: z.number().int(),
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
  id: cookbookShortcode,
  book: z.string(),
  author: z.array(z.string()),
  subjects: z.array(z.string()),
  recipeCount: z.number().int().nonnegative(),
  coverUrl: z.string().nullable(),
  sourceRecipeCount: z.number().int().nonnegative(),
  // The physical copy on the shelf, when one is linked. Deliberately thin —
  // this summary feeds the browse gallery, the cookbook picker, the hover
  // preview and MCP, so the detail page fetches the full Product separately
  // rather than making every one of those carry price and inventory joins.
  product: z
    .object({
      id: productShortcode,
      name: z.string(),
      coverUrl: z.string().nullable(),
    })
    .nullable(),
});
export type CookbookSummary = z.infer<typeof cookbookSummary>;

/**
 * The cover that represents a cookbook: its own cover, else the cover of the
 * physical copy on the shelf.
 *
 * `cookbookSummary.product.coverUrl` is already resolved server-side for every
 * summary and had no reader until this existed, so a cookbook whose only
 * photograph lived on its linked Product rendered the empty placeholder.
 *
 * Resolves a URL rather than an `ImageOut` — unlike the location and ingredient
 * cascades, both of cookbook's sources are already-flattened `coverUrl`
 * strings, so there is nothing for `firstDisplayableImage` to filter.
 */
export const cookbookCoverImage = (book: {
  coverUrl: string | null;
  product: { coverUrl: string | null } | null;
}): string | null => book.coverUrl ?? book.product?.coverUrl ?? null;

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

export const recipeFilterFields = {
  ...auditDateFilterFields,
  ...recipeRelatedFilterFields,
  nameFilter: z.string().optional(),
  tagFilters: z.array(z.string()).optional(),
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
  ...numericRangeFields("totalMinutes", { int: true, nonnegative: true }),
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
  // Public `IMG-` shortcode, like `removeImageIds`/`imageOrder` below —
  // `Image` mints a shortcode at insert time, so the repo layer resolves this
  // to a uuid before the join-table write rather than taking a raw uuid.
  pendingImageIds: z.array(imageShortcode).optional(),
};
export const recipeCreateInput = z.object(recipeCreateShape);

export const recipeUpdateData = deriveUpdateData(recipeCreateShape, {
  extend: {
    // Public `IMG-` codes, as returned by `RecipeOut.images[].id` — resolved to
    // uuids in the repo before they reach the `RecipeImage` join table. MCP has
    // no recipe image surface (`mcpRecipeUpdateInput` below doesn't extend
    // these in), so this pair is browser-transport-only.
    removeImageIds: z
      .array(imageShortcode)
      .optional()
      .describe(
        "Image ids to detach. Detaching DELETES the stored file when nothing else references it — there is no restore, and the id will not resolve again.",
      ),
    imageOrder: z
      .array(imageShortcode)
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

export const recipeTagsListOut = createItemsResponseSchema(z.string());

export const cookbookSummariesMcpOut =
  createItemsResponseSchema(cookbookSummary);
