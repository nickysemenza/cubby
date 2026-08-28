import { fdcId, type NutrientKey } from "@cubby/usda-schemas";
import { z } from "zod";
import { positiveAmount } from "./codec";
import { cookbookShortcode } from "./identifiers";
import { money } from "./money";

// Recipe source values - single source of truth for both Zod and Drizzle
export const recipeSourceValues = [
  "Book",
  "Website",
  "Other",
  "Notion",
] as const;

// Recipe yield schema - what the recipe produces. Reuses `positiveAmount`
// (value > 0, unit non-empty) rather than hand-rolling `{value, unit}` — that
// was already this schema's exact constraint, so this is behavior-preserving
// and additionally picks up `positiveAmount`'s optional `upperValue`, giving
// recipes range yields ("makes 10-12 cookies") for free.
export const recipeYieldSchema = positiveAmount;
export type RecipeYield = z.infer<typeof recipeYieldSchema>;

export const recipeTotalsFields = {
  costTotal: money,
  // Upper bound of the cost/calorie totals when the recipe has ranged amounts
  // ("2–3 cups"); absent for recipes with only point amounts. Additive/optional
  // so existing persisted rows validate unchanged.
  costTotalUpper: money.optional(),
  caloriesTotal: z.number(),
  caloriesTotalUpper: z.number().optional(),
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
export const recipeTotalsFieldNames = Object.keys(recipeTotalsFields).filter(
  (key): key is keyof RecipeTotals => key in recipeTotalsFields,
);

// The cost/calorie head of recipeTotals — the subset meal scaling carries. One
// source so the meal schemas can't drift from recipeTotals' field names or the
// optional upper-bound convention.
export const costCalorieTotals = z.object({
  costTotal: money,
  costTotalUpper: money.optional(),
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

// Costing explain payload (recipe.explainCosting + the MCP explain tool).
// Mirrors the diagnostics calculateTotals produces (lib/recipe-costing.ts) —
// the zod shapes are the wire contract; the lib types are the source.

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

const componentSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("own-full") }),
  z.object({ kind: z.literal("own-fraction"), fraction: z.number() }),
  z.object({ kind: z.literal("basis-fraction"), fraction: z.number() }),
  z.object({ kind: z.literal("flat-grams"), grams: z.number() }),
  z.object({ kind: z.literal("missing") }),
]);

// NOTE: the success arm is structurally `amount` (value/unit) plus the `ok`
// discriminant, but it deliberately does NOT reuse `codec.ts`'s `amount` here.
// `amount` is a refined ZodEffects (from `.refine()`), and zod's
// `discriminatedUnion` cannot introspect a refined/intersected member for its
// discriminant key — `z.object({ok: z.literal(true)}).and(amount)` throws
// "Invalid discriminated union option" at schema-construction time. Nesting
// instead (`z.object({ok, amount})`) would fix that but changes the wire
// shape from flat `{ok, value, unit}` to `{ok, amount: {value, unit}}`,
// rippling into every consumer that reads `.value`/`.unit` off this
// diagnostic — out of scope for a same-shape convention migration.
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

const rowMissing = z.object({
  price: z.boolean(),
  weight: z.boolean(),
  nutrients: z.boolean(),
});

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
  missing: rowMissing,
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
    stale: z.boolean(),
  }),
  computed: z.object({
    totals: recipeTotals,
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
/**
 * A recipe's printed times, as persisted. Each duration is carried twice: the
 * prose string is verbatim what the source printed (so display never rounds or
 * re-words it), the minute count is the same duration as a number so the list
 * can sort and filter in SQL. **A present string does not imply a present
 * count** — the EPUB extractor deliberately leaves the count absent for a range
 * or an open-ended phrase ("overnight") rather than guessing, so every renderer
 * must handle string-without-minutes.
 */
const recipeTimeProse = {
  active: z.string().nullish(),
  total: z.string().nullish(),
  prep: z.string().nullish(),
  cook: z.string().nullish(),
};
const positiveMinutes = () => z.number().int().nonnegative().nullish();
// Promoted to real `Recipe` columns: the list sorts and range-filters on these,
// which is server work — so they must be plain SQL, not jsonb extraction.
const recipeSortableMinutes = {
  activeMinutes: positiveMinutes(),
  totalMinutes: positiveMinutes(),
};
const recipeStoredMinutes = {
  prepMinutes: positiveMinutes(),
  cookMinutes: positiveMinutes(),
};

export const recipeTimes = z.object({
  ...recipeTimeProse,
  ...recipeSortableMinutes,
  ...recipeStoredMinutes,
});
export type RecipeTimes = z.infer<typeof recipeTimes>;

/**
 * `url` is DERIVED from the `SourceType`/`SourceData` columns on read (see
 * `dbRecipeToTopLevelShape`) — it is deliberately not stored in the `meta`
 * jsonb, so provenance keeps its single source of truth. Everything else here
 * is import-carried and persisted: `activeMinutes`/`totalMinutes` as real
 * integer columns, the rest inside `meta`.
 */
export const recipeMeta = z
  .object({
    url: z.url().nullable(),
    times: recipeTimes.nullish(),
    equipment: z.array(z.string()).nullish(),
    page: z.string().nullish(),
  })
  .nullable();
export type RecipeMeta = z.infer<typeof recipeMeta>;

export const recipeStoredMeta = z.object({
  times: z.object({ ...recipeTimeProse, ...recipeStoredMinutes }).nullish(),
  equipment: z.array(z.string()).nullish(),
  page: z.string().nullish(),
});
export type RecipeStoredMeta = z.infer<typeof recipeStoredMeta>;
export const recipeServings = z.number().int().positive();
export const recipeTags = z.array(z.string());
export const recipeNotes = z.string();

export const recipeSource = z.discriminatedUnion("type", [
  // `cookbookId` is the FK to the source Cookbook (nullable only for legacy book
  // rows predating the table); lets the UI link a recipe to its cookbook by id.
  z.object({
    type: z.literal("book"),
    book: z.string().min(1),
    cookbookId: cookbookShortcode.nullable(),
  }),
  z.object({ type: z.literal("website"), url: z.url() }),
  z.object({
    type: z.literal("notion"),
    pageId: z.string().min(1),
    url: z.url(),
  }),
  z.object({ type: z.literal("other") }),
]);
export type RecipeSource = z.infer<typeof recipeSource>;
