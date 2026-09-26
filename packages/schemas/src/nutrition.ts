import { TIER1_NUTRIENT_KEYS } from "@cubby/usda-schemas";
import { z } from "zod";

export const nutrientKey = z.enum(TIER1_NUTRIENT_KEYS);

const coverage = z
  .object({
    covered: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .refine(
    (value) => value.covered <= value.total,
    "Coverage exceeds the contributor count",
  )
  // A type-driven mock cannot satisfy `covered <= total`; pin one example.
  .meta({ mockValue: { covered: 1, total: 1 } });
export type MeasureEstimateCoverage = z.infer<typeof coverage>;

const knownEstimate = {
  lower: z.number().nonnegative(),
  upper: z.number().nonnegative().nullable(),
  coverage,
};

/** Bounds describe known contributions; partial estimates do not bound missing inputs. */
export const measureEstimate = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("complete"), ...knownEstimate }),
    z.object({ status: z.literal("partial"), ...knownEstimate }),
    z
      .object({
        status: z.literal("unavailable"),
        reason: z.enum(["no_data", "yield_missing", "empty"]),
        // Present when the aggregate saw contributors but priced none of them
        // (`covered` is always 0); absent for `empty` and rows persisted
        // before the field existed.
        coverage: coverage.optional(),
      })
      .refine(
        (value) => value.coverage === undefined || value.coverage.covered === 0,
        "Unavailable estimates cannot cover contributors",
      ),
    z.object({
      status: z.literal("pending"),
      reason: z.enum(["totals_missing", "totals_stale"]),
    }),
  ])
  .refine(
    (value) =>
      !("upper" in value) || value.upper == null || value.upper >= value.lower,
    "Upper amount is below the lower amount",
  );
export type MeasureEstimate = z.infer<typeof measureEstimate>;

export const nutritionEstimate = z.record(nutrientKey, measureEstimate);
export type NutritionEstimate = z.infer<typeof nutritionEstimate>;

/**
 * What `Recipe.totals` persists: cost plus the full nutrient catalog. The
 * read shape adds `macros`, a projection every reader would otherwise
 * derive by hand; it is never stored.
 */
export const storedNutritionTotals = z.object({
  cost: measureEstimate,
  nutrition: nutritionEstimate,
});
export type StoredNutritionTotals = z.infer<typeof storedNutritionTotals>;

/** The four everyday macros, each an honest estimate; `partial` when any is only partly known. */
export const macroSummary = z.object({
  calories: measureEstimate,
  protein: measureEstimate,
  carbs: measureEstimate,
  fat: measureEstimate,
  partial: z.boolean(),
});
export type MacroSummary = z.infer<typeof macroSummary>;

export const nutritionTotals = storedNutritionTotals.extend({
  macros: macroSummary,
});
export type NutritionTotals = z.infer<typeof nutritionTotals>;

export const macrosOf = (nutrition: NutritionEstimate): MacroSummary => {
  const macros = {
    calories: nutrition.kcal,
    protein: nutrition.protein,
    carbs: nutrition.carbs,
    fat: nutrition.fat,
  };
  return {
    ...macros,
    partial: Object.values(macros).some(
      (estimate) => estimate.status === "partial",
    ),
  };
};

/** The read shape of stored or freshly computed totals. */
export const withMacros = (totals: StoredNutritionTotals): NutritionTotals => ({
  cost: totals.cost,
  nutrition: totals.nutrition,
  macros: macrosOf(totals.nutrition),
});

/**
 * The preview figure of one estimate: its known amount when complete or
 * partial (a partial `lower` sums only what is known), `null` otherwise.
 */
const estimateFigure = (
  estimate: MeasureEstimate | undefined,
  digits: number,
): number | null =>
  estimate?.status === "complete" || estimate?.status === "partial"
    ? Number(estimate.lower.toFixed(digits))
    : null;

/**
 * The flat preview projection of recipe or meal totals — the facts the hover
 * card declares with `display.preview`, read off the same estimates.
 */
export const totalsPreview = (
  totals: Pick<NutritionTotals, "cost" | "macros"> | null | undefined,
) => ({
  cost: estimateFigure(totals?.cost, 2),
  calories: estimateFigure(totals?.macros.calories, 0),
  protein: estimateFigure(totals?.macros.protein, 1),
  carbs: estimateFigure(totals?.macros.carbs, 1),
  fat: estimateFigure(totals?.macros.fat, 1),
});

/** What to persist: `macros` is a projection and never reaches the column. */
export const toStoredTotals = ({
  cost,
  nutrition,
}: StoredNutritionTotals): StoredNutritionTotals => ({ cost, nutrition });

/**
 * Totals whose nutrient record may be a subset of the 22 keys — the shape an
 * MCP read publishes when the caller asked for `kcal` only or no nutrition.
 * `z.record` over an enum key is exhaustive in Zod 4; `partialRecord` is the
 * only way to say "some of these keys".
 */
export const nutritionTotalsPartial = z.object({
  cost: measureEstimate,
  nutrition: z.partialRecord(nutrientKey, measureEstimate),
});
export type NutritionTotalsPartial = z.infer<typeof nutritionTotalsPartial>;

export const nutritionBasis = z.enum(["whole", "serving"]);
export type NutritionBasis = z.infer<typeof nutritionBasis>;

export const hasKnownEstimate = (
  estimate: MeasureEstimate,
): estimate is Extract<MeasureEstimate, { status: "complete" | "partial" }> =>
  estimate.status === "complete" || estimate.status === "partial";

/** Contributor counts for known or unavailable estimates; `undefined` when unknown. */
export const estimateCoverage = (
  estimate: MeasureEstimate,
): MeasureEstimateCoverage | undefined =>
  hasKnownEstimate(estimate) || estimate.status === "unavailable"
    ? estimate.coverage
    : undefined;

/** Build every catalog entry, including unavailable nutrients, without a sparse record. */
export const buildNutrition = (
  getEstimate: (key: z.infer<typeof nutrientKey>) => MeasureEstimate,
): NutritionEstimate =>
  nutritionEstimate.parse(
    Object.fromEntries(
      TIER1_NUTRIENT_KEYS.map((key) => [key, getEstimate(key)]),
    ),
  );

/**
 * A per-product Nutrition Facts override, transcribed from a package label —
 * for products USDA has no entry for (e.g. a store-brand tortilla). Stored
 * per the label's stated serving (what a package prints); scaled to per-100 g
 * at the TS→WASM boundary (`label-nutrition.ts`). Precedence: label > fdc_id
 * (USDA) > none.
 */
export const productLabelNutrition = z
  .object({
    /** Grams in the label's stated serving (Hero tortilla: 44). */
    servingGrams: z.number().positive(),
    /** Per-serving amounts exactly as printed, in each key's TIER1 unit. */
    nutrients: z.partialRecord(nutrientKey, z.number().nonnegative()),
    /** Provenance note, e.g. "Hero package label". */
    source: z.string().nullable(),
  })
  .refine(
    (v) => Object.keys(v.nutrients).length > 0,
    "A label needs at least one nutrient",
  );
export type ProductLabelNutrition = z.infer<typeof productLabelNutrition>;
