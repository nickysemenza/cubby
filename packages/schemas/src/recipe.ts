import { fdcId, type NutrientKey } from "@cubby/usda-schemas";
import { z } from "zod";
import { amount } from "./codec";
import { baseEntitySchema, dbTimestampsOut, requiredName } from "./common";
import { cookbookId, id, ingredientId, recipeId } from "./identifiers";
import { createInputImages, imageOut, updateInputImages } from "./image";

// Recipe source values - single source of truth for both Zod and Drizzle
export const recipeSourceValues = [
  "Book",
  "Website",
  "Other",
  "Notion",
] as const;

// Recipe yield schema - what the recipe produces
export const recipeYieldSchema = z.object({
  value: z.number().positive(),
  unit: z.string().min(1),
});
export type RecipeYield = z.infer<typeof recipeYieldSchema>;

// Precomputed cost/calorie rollup for a recipe, persisted as a `totals` jsonb
// column and surfaced on `recipeOut.totals`. Covered counts (out of
// ingredientCount) drive the list's coverage display. Computed server-side; see
// recipe-costing.service.
export const recipeTotals = z.object({
  costTotal: z.number(),
  // Upper bound of the cost/calorie totals when the recipe has ranged amounts
  // ("2–3 cups"); absent for recipes with only point amounts. Additive/optional
  // so existing persisted rows validate unchanged.
  costTotalUpper: z.number().optional(),
  caloriesTotal: z.number(),
  caloriesTotalUpper: z.number().optional(),
  // Whole-recipe macro rollup (grams; sodium in mg). Optional/additive so rows
  // persisted before this was added still validate — they backfill on recompute.
  proteinTotal: z.number().optional(),
  fatTotal: z.number().optional(),
  carbsTotal: z.number().optional(),
  fiberTotal: z.number().optional(),
  sodiumTotal: z.number().optional(),
  ingredientCount: z.number().int(),
  costCovered: z.number().int(),
  caloriesCovered: z.number().int(),
});
export type RecipeTotals = z.infer<typeof recipeTotals>;

/**
 * What an edit recomputed downstream, returned on a product/ingredient/recipe
 * mutation so the client can confirm "recomputed N recipes, Y valuations" — one
 * shared shape so the message can't drift per call site. Eager: the work happens
 * in the same request, not deferred to the Problems-page drain.
 */
export const recomputeSummary = z.object({
  recipesRecomputed: z.number().int().nonnegative(),
  inventoryValuationsUpdated: z.number().int().nonnegative(),
});
export type RecomputeSummary = z.infer<typeof recomputeSummary>;

// The cost/calorie head of recipeTotals — the subset meal scaling carries. One
// source so the meal schemas can't drift from recipeTotals' field names or the
// optional upper-bound convention.
export const costCalorieTotals = recipeTotals.pick({
  costTotal: true,
  costTotalUpper: true,
  caloriesTotal: true,
  caloriesTotalUpper: true,
});

// The five whole-recipe macros carried on RecipeTotals as flat `${key}Total`
// columns (proteinTotal, fatTotal, …). One roster so the costing service (write)
// and the preview card (read) drive the same set — add a macro here only, and
// the `${key}Total` convention keeps the column names in lockstep with the keys.
export const RECIPE_MACRO_KEYS = [
  "protein",
  "fat",
  "carbs",
  "fiber",
  "sodium",
] as const satisfies readonly NutrientKey[];
export type RecipeMacroColumn = `${(typeof RECIPE_MACRO_KEYS)[number]}Total`;

// ---------------------------------------------------------------------------
// Costing explain payload (recipe.explainCosting + the MCP explain tool).
// Mirrors the diagnostics calculateTotals produces (lib/recipe-costing.ts) —
// the zod shapes are the wire contract; the lib types are the source.
// ---------------------------------------------------------------------------

/** The role the usage classifier assigned to a row (mirrors WIngredientUsage). */
export const ingredientUsage = z.enum([
  "normal",
  "frying_medium",
  "pan_grease",
  "seasoning",
  "dredging",
  "garnish",
  "marinade",
]);

/** Where one measure of a row resolves from (mirrors ComponentSource). */
const componentSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("own-full") }),
  z.object({ kind: z.literal("own-fraction"), fraction: z.number() }),
  z.object({ kind: z.literal("basis-fraction"), fraction: z.number() }),
  z.object({ kind: z.literal("flat-grams"), grams: z.number() }),
  z.object({ kind: z.literal("missing") }),
]);

const measureDiagnostic = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.number(), unit: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type MeasureDiagnosticOut = z.infer<typeof measureDiagnostic>;

const nutrientDiagnostic = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    kcal: z.number().nullable(),
    nutrientCount: z.number().int(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type NutrientDiagnosticOut = z.infer<typeof nutrientDiagnostic>;

/** One hop of an explained unit-graph conversion (normalized nodes). */
export const conversionStep = z.object({
  from_unit: z.string(),
  to_unit: z.string(),
  factor: z.number(),
});

export const rowDiagnostic = z.object({
  id: z.string(),
  name: z.string(),
  sectionName: z.string().nullable(),
  kind: z.enum(["ingredient", "recipe"]),
  usage: ingredientUsage,
  measured: z.boolean(),
  plan: z.object({
    cost: componentSource,
    weight: componentSource,
    nutrients: componentSource,
  }),
  basisGrams: z.number().nullable(),
  price: measureDiagnostic,
  gram: measureDiagnostic,
  nutrient: nutrientDiagnostic,
  /** Unit-graph routes per measure (explain endpoint only; null = no path). */
  paths: z
    .object({
      money: z.array(conversionStep).nullable(),
      weight: z.array(conversionStep).nullable(),
      calories: z.array(conversionStep).nullable(),
    })
    .nullish(),
});
export type RowDiagnosticOut = z.infer<typeof rowDiagnostic>;

/** Full costing explanation: persisted state vs a fresh compute, with drift. */
export const recipeCostingExplain = z.object({
  persisted: z.object({
    totals: recipeTotals.nullable(),
    totalsComputedAt: z.date().nullable(),
    /** true ⇒ the drain will recompute this recipe (totalsComputedAt is null). */
    stale: z.boolean(),
  }),
  computed: z.object({
    totals: recipeTotals,
    /** false ⇒ a USDA lookup that should resolve came back null (retry later). */
    complete: z.boolean(),
    diagnostics: z.array(rowDiagnostic),
    usdaMisses: z.array(
      z.object({
        ingredientName: z.string(),
        productName: z.string(),
        fdcId,
      }),
    ),
  }),
  drift: z.object({ cost: z.boolean(), calories: z.boolean() }),
});
export type RecipeCostingExplain = z.infer<typeof recipeCostingExplain>;

// Shared building blocks for a recipe's writable fields. Defined once here so the
// output (recipeTopLevel), API input (recipeCreateInput), and the form's formSchema
// stay in sync. Each consumer applies its own null/optional wrapper because the
// optionality legitimately differs per layer (output uses nullish, input uses
// nullable+optional, the form always sends the key as null).
export const recipeMeta = z.object({ url: z.url().nullable() }).nullable();
export const recipeServings = z.number().int().positive();
export const recipeTags = z.array(z.string());
// Freeform markdown: headnote/intro blurb plus tips. Imports compose it from
// the source's description + notes (see composeNotesMarkdown).
export const recipeNotes = z.string();

// A recipe's provenance as a strong discriminated union — invalid pairings
// (a Book with no book, a Website with no URL) are unrepresentable. Maps to/from
// the DB's `SourceType` + `SourceData` columns via the repo-side codec
// (`~/server/repo/recipe/source`); no migration. This is what finally exposes a
// cookbook recipe's book name in the API (`meta.url` only ever held web URLs).
export const recipeSource = z.discriminatedUnion("type", [
  // `cookbookId` is the FK to the source Cookbook (nullable only for legacy book
  // rows predating the table); lets the UI link a recipe to its cookbook by id.
  z.object({
    type: z.literal("book"),
    book: z.string().min(1),
    cookbookId: cookbookId.nullable(),
  }),
  z.object({ type: z.literal("website"), url: z.url() }),
  // Notion-synced: `pageId` is the stable idempotency key (stored in SourceData);
  // `url` is the page link derived from it, for the source badge.
  z.object({
    type: z.literal("notion"),
    pageId: z.string().min(1),
    url: z.url(),
  }),
  z.object({ type: z.literal("other") }),
]);
export type RecipeSource = z.infer<typeof recipeSource>;

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
const sectioningredientOut = z
  .object({
    id: z.uuid(),
    amounts: z.array(amount),
    // Provenance from import: the original unparsed line and the parser-derived
    // modifier. Null for rows created before capture, or manual/UI edits.
    rawLine: z.string().nullish(),
    modifier: z.string().nullish(),
  })
  .extend(dbTimestampsOut.shape);

// Create a discriminated union to ensure either recipe or ingredient is set
export const sectionIngredientOut = z.discriminatedUnion("type", [
  sectioningredientOut.extend({
    type: z.literal("ingredient"),
    recipe: z.null(),
    ingredient: ingredientOut,
  }),
  sectioningredientOut.extend({
    type: z.literal("recipe"),
    recipe: recipeTopLevel,
    ingredient: z.null(),
  }),
]);

export type SectionIngredient = z.infer<typeof sectionIngredientOut>;

export const recipeSectionOut = z
  .object({
    id: z.uuid(),
    name: z.string().nullable(),
    ingredients: z.array(sectionIngredientOut),
    instructions: z.array(z.object({ instruction: z.string() })),
  })
  .extend(dbTimestampsOut.shape);

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

// Summary shape for `recipe.list`: scalar fields + persisted totals, no section graph (the list/pickers never read `.sections` — that was the ~4.7s over-fetch).
export const recipeListItemOut = recipeTopLevel.extend({
  totals: recipeTotals.nullish(),
});
export type RecipeListItem = z.infer<typeof recipeListItemOut>;

export type RecipeOut = z.infer<typeof recipeOut>;

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
    amounts: z.array(amount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
  z.object({
    type: z.literal("recipe"),
    recipeId: recipeId,
    ingredientId: z.null(),
    amounts: z.array(amount),
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
export const recipeFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  // Scope the list to one cookbook by FK id (cookbook detail page).
  cookbookId: cookbookId.optional(),
});

// surface to MCP clients via `recipeCreateInput.shape` — see the create_recipe /
// update_recipe tools. `recipeUpdateInput` inherits them through `.partial()`.
export const recipeCreateInput = z
  .object({
    name: requiredName("Recipe name").describe("Recipe name"),
    meta: recipeMeta.describe(
      "Source metadata, e.g. { url } of the web source",
    ),
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
  })
  .extend(createInputImages.shape);

export const recipeUpdateInput = z.object({
  id: recipeId,
  data: recipeCreateInput.partial().extend(updateInputImages.shape),
});

export type RecipeCreateInput = z.infer<typeof recipeCreateInput>;
export type RecipeUpdateInput = z.infer<typeof recipeUpdateInput>;
