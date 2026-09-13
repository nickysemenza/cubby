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
  );

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
    z.object({
      status: z.literal("unavailable"),
      reason: z.enum(["no_data", "yield_missing", "empty"]),
    }),
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

export const nutritionTotals = z.object({
  cost: measureEstimate,
  nutrition: nutritionEstimate,
});
export type NutritionTotals = z.infer<typeof nutritionTotals>;

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

/** Build every catalog entry, including unavailable nutrients, without a sparse record. */
export const buildNutrition = (
  getEstimate: (key: z.infer<typeof nutrientKey>) => MeasureEstimate,
): NutritionEstimate =>
  nutritionEstimate.parse(
    Object.fromEntries(
      TIER1_NUTRIENT_KEYS.map((key) => [key, getEstimate(key)]),
    ),
  );
