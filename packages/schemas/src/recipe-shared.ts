import { fdcId, type NutrientKey } from "@cubby/usda-schemas";
import { z } from "zod";
import { cookbookId } from "./identifiers";

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
export const recipeTotalsFields = {
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
};

export const recipeTotals = z.object(recipeTotalsFields);
export type RecipeTotals = z.infer<typeof recipeTotals>;
export const recipeTotalsFieldNames = Object.keys(
  recipeTotalsFields,
) as (keyof RecipeTotals)[];

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
export const costCalorieTotals = z.object({
  costTotal: z.number(),
  costTotalUpper: z.number().optional(),
  caloriesTotal: z.number(),
  caloriesTotalUpper: z.number().optional(),
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

// Shared building blocks for a recipe's writable fields. Defined once here so
// output schemas, API inputs, and form adapters stay in sync. Each consumer
// applies its own null/optional wrapper because the optionality legitimately
// differs per layer.
export const recipeMeta = z.object({ url: z.url().nullable() }).nullable();
export const recipeServings = z.number().int().positive();
export const recipeTags = z.array(z.string());
// Freeform markdown: headnote/intro blurb plus tips. Imports compose it from
// the source's description + notes (see composeNotesMarkdown).
export const recipeNotes = z.string();

// A recipe's provenance as a strong discriminated union — invalid pairings
// (a Book with no book, a Website with no URL) are unrepresentable. Maps to/from
// the DB's `SourceType` + `SourceData` columns via the repo-side codec
// (`~/server/repo/recipe/source`); no migration.
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
