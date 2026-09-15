import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { FoodPortion, NutrientsPer100 } from "@cubby/usda-schemas";
import { useMemo, useState } from "react";

import { Stack } from "~/components/layout";
import { ChoiceSwitcher } from "~/components/ui/view-switcher";
import { sourceNutritionEstimate } from "~/lib/nutrition-format";
import { safeConvertAmount } from "~/lib/recipe-costing";
import { usdaNutrientBasis } from "~/lib/unit-mapping-utils";

import { NutritionLabel } from "./NutritionLabel";

/**
 * The serving basis a product's label can toggle to, resolved in priority
 * order: a `1 serving → <basis>` graph conversion (a custom serving alias or a
 * branded-food serving edge) wins over the food's first USDA household
 * portion (e.g. almond milk's `1 cup = 262 g`). Null when neither exists —
 * then the card renders per-100-basis only, with no toggle.
 *
 * `basis` is "g" for the ordinary per-100-gram USDA record, or "ml" for
 * mL-serving branded foods (USDA reports those nutrients per 100 mL, not per
 * 100 g — see `nutrient_basis_unit` in `food_mappings.rs`). The USDA-portion
 * fallback (`gram_weight`) and the `labelServingGrams` fallback are both
 * gram-based, so they only apply when `basis` is "g".
 */
const resolveServingBasis = (
  mappings: UnitMapping[],
  portions: readonly FoodPortion[],
  basis: "g" | "ml",
  /**
   * A package label's own stated serving (grams), used only when neither the
   * unit-mapping graph nor USDA portions resolve a basis — a label has no
   * portion list and only synthesizes per-100g nutrient edges (see
   * `labelNutritionMappings`), not a "1 serving = X g" conversion, so without
   * this fallback a labelled product's toggle would never appear.
   */
  labelServingGrams?: number,
): { label: string; amount: number } | null => {
  const kind = basis === "ml" ? "volume" : "weight";
  const serving = safeConvertAmount(
    { value: 1, unit: "serving" },
    mappings,
    kind,
  );
  if (
    serving.isOk() &&
    serving.value.unit === basis &&
    Number.isFinite(serving.value.value) &&
    serving.value.value > 0
  ) {
    return { label: "1 serving", amount: serving.value.value };
  }
  if (basis === "g") {
    const portion = portions.find((p) => p.gram_weight > 0);
    if (portion) {
      return {
        label: `${portion.amount} ${portion.modifier ?? "portion"}`,
        amount: portion.gram_weight,
      };
    }
    if (labelServingGrams != null && labelServingGrams > 0) {
      return { label: "1 serving", amount: labelServingGrams };
    }
  }
  return null;
};

const trimAmount = (v: number) => Number(v.toFixed(1)).toString();

/**
 * Product-detail nutrition label with a per-100-basis / per-serving toggle
 * (basis is "g", or "ml" for mL-serving branded foods). The per-serving view
 * is linear scaling of the USDA per-100-basis record by the resolved basis
 * amount — the same arithmetic the serving-alias preview and
 * `scaleNutrition` do; the basis amount itself comes from the WASM graph.
 */
export function ProductNutritionLabel({
  nutrients,
  mappings,
  portions,
  servingGrams,
}: {
  nutrients: NutrientsPer100;
  mappings: UnitMapping[];
  portions: readonly FoodPortion[];
  /** A package label's stated serving grams — see `resolveServingBasis`. */
  servingGrams?: number;
}) {
  const nutrientBasis = useMemo(() => usdaNutrientBasis(mappings), [mappings]);
  const basis = useMemo(
    () => resolveServingBasis(mappings, portions, nutrientBasis, servingGrams),
    [mappings, portions, nutrientBasis, servingGrams],
  );
  const [view, setView] = useState<"per100" | "serving">("per100");

  const scaled = useMemo(() => {
    if (!basis) return nutrients;
    const factor = basis.amount / 100;
    return Object.fromEntries(
      Object.entries(nutrients).map(([code, value]) => [code, value * factor]),
    );
  }, [nutrients, basis]);

  const showServing = view === "serving" && basis !== null;
  const basisLabel = nutrientBasis === "ml" ? "mL" : "g";

  return (
    <Stack gap="sm">
      {basis && (
        <ChoiceSwitcher
          ariaLabel="Nutrition basis"
          options={[
            { value: "per100", label: `Per 100 ${basisLabel}` },
            { value: "serving", label: `Per ${basis.label}` },
          ]}
          value={view}
          onValueChange={setView}
        />
      )}
      <NutritionLabel
        estimates={sourceNutritionEstimate(
          showServing && basis ? scaled : nutrients,
        )}
        servingLabel={
          showServing && basis
            ? `per ${basis.label} (${trimAmount(basis.amount)} ${basisLabel})`
            : `per 100 ${basisLabel}`
        }
      />
    </Stack>
  );
}
