import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { FoodPortion, NutrientsPer100 } from "@cubby/usda-schemas";
import { useMemo, useState } from "react";

import { Stack } from "~/components/layout";
import { ChoiceSwitcher } from "~/components/ui/view-switcher";
import { sourceNutritionEstimate } from "~/lib/nutrition-format";
import { safeConvertAmount } from "~/lib/recipe-costing";

import { NutritionLabel } from "./NutritionLabel";

/**
 * The serving basis a product's label can toggle to, resolved in priority
 * order: a `1 serving → g` graph conversion (a custom serving alias or a
 * branded-food serving edge) wins over the food's first USDA household
 * portion (e.g. almond milk's `1 cup = 262 g`). Null when neither exists —
 * then the card renders per-100g only, with no toggle.
 */
const resolveServingBasis = (
  mappings: UnitMapping[],
  portions: readonly FoodPortion[],
): { label: string; grams: number } | null => {
  const serving = safeConvertAmount(
    { value: 1, unit: "serving" },
    mappings,
    "weight",
  );
  if (
    serving.isOk() &&
    serving.value.unit === "g" &&
    Number.isFinite(serving.value.value) &&
    serving.value.value > 0
  ) {
    return { label: "1 serving", grams: serving.value.value };
  }
  const portion = portions.find((p) => p.gram_weight > 0);
  if (portion) {
    return {
      label: `${portion.amount} ${portion.modifier ?? "portion"}`,
      grams: portion.gram_weight,
    };
  }
  return null;
};

const trimGrams = (v: number) => Number(v.toFixed(1)).toString();

/**
 * Product-detail nutrition label with a per-100g / per-serving toggle. The
 * per-serving view is linear scaling of the USDA per-100g record by the
 * resolved basis grams — the same arithmetic the serving-alias preview and
 * `scaleNutrition` do; the basis grams themselves come from the WASM graph.
 */
export function ProductNutritionLabel({
  nutrients,
  mappings,
  portions,
}: {
  nutrients: NutrientsPer100;
  mappings: UnitMapping[];
  portions: readonly FoodPortion[];
}) {
  const basis = useMemo(
    () => resolveServingBasis(mappings, portions),
    [mappings, portions],
  );
  const [view, setView] = useState<"per100" | "serving">("per100");

  const scaled = useMemo(() => {
    if (!basis) return nutrients;
    const factor = basis.grams / 100;
    return Object.fromEntries(
      Object.entries(nutrients).map(([code, value]) => [code, value * factor]),
    );
  }, [nutrients, basis]);

  const showServing = view === "serving" && basis !== null;

  return (
    <Stack gap="sm">
      {basis && (
        <ChoiceSwitcher
          ariaLabel="Nutrition basis"
          options={[
            { value: "per100", label: "Per 100 g" },
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
            ? `per ${basis.label} (${trimGrams(basis.grams)} g)`
            : "per 100 g"
        }
      />
    </Stack>
  );
}
