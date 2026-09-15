import type { NutritionTotals } from "@cubby/schemas/nutrition";
import {
  KEY_NUTRIENT_KEYS,
  type NutrientKey,
  TIER1_NUTRIENT_KEYS,
  TIER1_NUTRIENTS,
} from "@cubby/usda-schemas";

import { estimateStatusText, formatEstimate } from "~/lib/nutrition-format";
import { formatCurrency } from "~/lib/utils";

const DEFAULT_NUTRIENTS = new Set<NutrientKey>(KEY_NUTRIENT_KEYS);

export const formatCostEstimate = (totals: NutritionTotals): string =>
  formatEstimate(totals.cost, (value) => formatCurrency(value));

const formatNutrientEstimate = (
  totals: NutritionTotals,
  key: NutrientKey,
): string => {
  const unit = TIER1_NUTRIENTS[key].unit.toLowerCase();
  return formatEstimate(totals.nutrition[key], (value) =>
    key === "kcal"
      ? `${Math.round(value).toLocaleString()} ${unit}`
      : `${Number(value.toFixed(1)).toLocaleString()} ${unit}`,
  );
};

function NutrientRows({
  totals,
  keys,
}: {
  totals: NutritionTotals;
  keys: readonly NutrientKey[];
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-2xs sm:grid-cols-2 lg:grid-cols-3">
      {keys.map((key) => (
        <div key={key} className="flex min-w-0 items-baseline gap-1">
          <dt className="truncate text-muted-foreground">
            {TIER1_NUTRIENTS[key].displayName}
          </dt>
          <dd
            className="ml-auto min-w-0 text-right font-mono tabular-nums"
            title={estimateStatusText(totals.nutrition[key]) ?? undefined}
          >
            {formatNutrientEstimate(totals, key)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Six everyday measures first, with the complete current catalog disclosed. */
export function MealNutritionEstimates({
  totals,
}: {
  totals: NutritionTotals;
}) {
  const more = TIER1_NUTRIENT_KEYS.filter((key) => !DEFAULT_NUTRIENTS.has(key));
  return (
    <div className="space-y-2">
      <NutrientRows totals={totals} keys={KEY_NUTRIENT_KEYS} />
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          More nutrients
        </summary>
        <div className="mt-2 border-t pt-2">
          <NutrientRows totals={totals} keys={more} />
        </div>
      </details>
    </div>
  );
}
