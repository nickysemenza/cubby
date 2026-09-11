import {
  hasKnownEstimate,
  type NutritionEstimate,
} from "@cubby/schemas/nutrition";
import {
  dailyValuePct,
  isNutrientKey,
  type NutrientKey,
  TIER1_NUTRIENTS,
} from "@cubby/usda-schemas";

import { estimateStatusText, formatEstimate } from "~/lib/nutrition-format";
import { cn } from "~/lib/utils";

/**
 * FDA label order for the macro block — Total Fat (Saturated Fat), Cholesterol,
 * Sodium, Carbohydrate (Fiber), Protein. `kcal` is handled separately as the
 * large Calories row above this list, so it's excluded here.
 */
const MACRO_ORDER: readonly NutrientKey[] = [
  "fat",
  "saturated_fat",
  "cholesterol",
  "sodium",
  "carbs",
  "fiber",
  "protein",
];

/**
 * Everything else, in TIER1_NUTRIENTS' own declaration order (minerals, then
 * vitamins) — the FDA label doesn't mandate an order beyond "after the
 * macros", so the source roster's grouping is a reasonable default.
 */
const MICRO_ORDER: readonly NutrientKey[] = Object.keys(TIER1_NUTRIENTS)
  .filter(isNutrientKey)
  .filter((key) => key !== "kcal" && !MACRO_ORDER.includes(key));

const ROW_ORDER: readonly NutrientKey[] = [...MACRO_ORDER, ...MICRO_ORDER];

/** Sub-nutrients indented under their parent macro when present. */
const SUB_NUTRIENTS: ReadonlySet<NutrientKey> = new Set([
  "saturated_fat",
  "fiber",
]);

// Trim trailing-zero decimals: 18.0 -> "18", 1.7 -> "1.7" — matches
// NutrientsSummary's amount formatting so figures read consistently app-wide.
const trimAmount = (v: number) => Number(v.toFixed(1)).toString();

const formatAmount = (
  estimate: NutritionEstimate[NutrientKey],
  unit: string,
): string =>
  formatEstimate(estimate, (value) => `${trimAmount(value)} ${unit}`);

const formatDailyValue = (
  nutrientKey: NutrientKey,
  estimate: NutritionEstimate[NutrientKey],
) => {
  if (!hasKnownEstimate(estimate)) {
    return { label: "—", title: estimateStatusText(estimate) ?? undefined };
  }
  if (estimate.status === "partial") {
    return {
      label: "—",
      title: "Daily Value omitted because the nutrient estimate is partial",
    };
  }

  const lower = Math.round(dailyValuePct(nutrientKey, estimate.lower));
  const upper =
    estimate.upper == null
      ? null
      : Math.round(dailyValuePct(nutrientKey, estimate.upper));
  return {
    label:
      upper == null || upper === lower ? `${lower}%` : `${lower}–${upper}%`,
  };
};

function NutrientRow({
  nutrientKey,
  estimate,
}: {
  nutrientKey: NutrientKey;
  estimate: NutritionEstimate[NutrientKey];
}) {
  const info = TIER1_NUTRIENTS[nutrientKey];
  const indented = SUB_NUTRIENTS.has(nutrientKey);
  const amount = formatAmount(estimate, info.unit.toLowerCase());
  const status = estimateStatusText(estimate);
  const dailyValue = formatDailyValue(nutrientKey, estimate);

  return (
    <section
      aria-label={info.displayName}
      className={cn(
        "flex items-baseline justify-between gap-2 border-t border-border py-1 text-sm",
        indented && "pl-4",
      )}
    >
      <span className={indented ? "text-muted-foreground" : "font-medium"}>
        {info.displayName}{" "}
        <span
          className="font-mono text-xs text-muted-foreground tabular-nums"
          title={status ?? undefined}
        >
          {amount}
        </span>
      </span>
      <span
        className="font-mono font-semibold tabular-nums"
        title={dailyValue.title}
      >
        {dailyValue.label}
      </span>
    </section>
  );
}

/**
 * A classic FDA-style Nutrition Facts label, driven entirely by the WASM-costed
 * nutrient totals. The core FDA rows stay visible when values are missing so
 * absence cannot look like zero; micronutrients appear when they have a value
 * or a pending calculation. Complete ranges retain ranged %DV, while partial
 * estimates omit %DV because the known subtotal is not a bound on missing data.
 */
export function NutritionLabel({
  estimates,
  servingLabel,
  note,
}: {
  estimates: NutritionEstimate;
  servingLabel: string;
  note?: string;
}) {
  const kcalEstimate = estimates.kcal;
  const rows = ROW_ORDER.filter(
    (key) =>
      MACRO_ORDER.includes(key) || estimates[key].status !== "unavailable",
  );

  return (
    <div className="max-w-sm border-4 border-foreground bg-background p-4 font-mono text-foreground">
      <div className="border-b-8 border-foreground pb-1">
        <h3 className="text-2xl leading-tight font-black tracking-tight">
          Nutrition Facts
        </h3>
        <p className="text-xs text-muted-foreground">{servingLabel}</p>
      </div>

      <div className="flex items-baseline justify-between border-b-4 border-foreground py-1">
        <span className="text-lg font-bold">Calories</span>
        <span className="text-2xl font-bold tabular-nums">
          <span title={estimateStatusText(kcalEstimate) ?? undefined}>
            {formatEstimate(kcalEstimate, (value) => `${Math.round(value)}`)}
          </span>
        </span>
      </div>

      <div className="flex justify-end border-b border-border py-1 text-2xs tracking-wider text-muted-foreground uppercase">
        % Daily Value*
      </div>

      {rows.map((key) => (
        <NutrientRow key={key} nutrientKey={key} estimate={estimates[key]} />
      ))}

      <p className="border-t-4 border-foreground pt-1 text-2xs text-muted-foreground">
        * % Daily Value based on a 2,000 calorie diet.{note ? ` ${note}` : ""}
      </p>
    </div>
  );
}
