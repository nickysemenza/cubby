import {
  dailyValuePct,
  getNutrientValueByKey,
  type NutrientKey,
  type NutrientsPer100,
  TIER1_NUTRIENTS,
} from "@cubby/usda-schemas";
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
const MICRO_ORDER: readonly NutrientKey[] = (
  Object.keys(TIER1_NUTRIENTS) as NutrientKey[]
).filter((key) => key !== "kcal" && !MACRO_ORDER.includes(key));

const ROW_ORDER: readonly NutrientKey[] = [...MACRO_ORDER, ...MICRO_ORDER];

/** Sub-nutrients indented under their parent macro when present. */
const SUB_NUTRIENTS: ReadonlySet<NutrientKey> = new Set([
  "saturated_fat",
  "fiber",
]);

// Trim trailing-zero decimals: 18.0 -> "18", 1.7 -> "1.7" — matches
// NutrientsSummary's amount formatting so figures read consistently app-wide.
const trimAmount = (v: number) => Number(v.toFixed(1)).toString();

function NutrientRow({
  nutrientKey,
  value,
}: {
  nutrientKey: NutrientKey;
  value: number;
}) {
  const info = TIER1_NUTRIENTS[nutrientKey];
  const indented = SUB_NUTRIENTS.has(nutrientKey);
  const pct = Math.round(dailyValuePct(nutrientKey, value));

  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-2 border-border border-t py-1 text-sm",
        indented && "pl-4",
      )}
    >
      <span className={indented ? "text-muted-foreground" : "font-medium"}>
        {info.displayName}{" "}
        <span className="font-mono text-muted-foreground text-xs tabular-nums">
          {trimAmount(value)}
          {info.unit.toLowerCase()}
        </span>
      </span>
      <span className="font-mono font-semibold tabular-nums">{pct}%</span>
    </div>
  );
}

/**
 * A classic FDA-style Nutrition Facts label, driven entirely by the WASM-costed
 * nutrient totals — no re-derivation of %DV or unit formatting in TS beyond the
 * `dailyValuePct` helper. Renders only the tier-1 codes present in `nutrients`
 * with a positive value (Calories always shows if present), ordered macros
 * first (FDA order) then micronutrients, with saturated fat / fiber indented
 * under their parent macro.
 */
export function NutritionLabel({
  nutrients,
  servingLabel,
  note,
}: {
  nutrients: NutrientsPer100;
  servingLabel: string;
  note?: string;
}) {
  const kcal = getNutrientValueByKey(nutrients, "kcal");
  const rows = ROW_ORDER.filter(
    (key) => getNutrientValueByKey(nutrients, key) > 0,
  );

  if (kcal <= 0 && rows.length === 0) return null;

  return (
    <div className="max-w-sm border-4 border-foreground bg-background p-4 font-mono text-foreground">
      <div className="border-foreground border-b-8 pb-1">
        <h3 className="font-black text-2xl leading-tight tracking-tight">
          Nutrition Facts
        </h3>
        <p className="text-muted-foreground text-xs">{servingLabel}</p>
      </div>

      {kcal > 0 && (
        <div className="flex items-baseline justify-between border-foreground border-b-4 py-1">
          <span className="font-bold text-lg">Calories</span>
          <span className="font-bold text-2xl tabular-nums">
            {Math.round(kcal)}
          </span>
        </div>
      )}

      <div className="flex justify-end border-border border-b py-1 text-2xs text-muted-foreground uppercase tracking-wider">
        % Daily Value*
      </div>

      {rows.map((key) => (
        <NutrientRow
          key={key}
          nutrientKey={key}
          value={getNutrientValueByKey(nutrients, key)}
        />
      ))}

      <p className="border-foreground border-t-4 pt-1 text-2xs text-muted-foreground">
        * % Daily Value based on a 2,000 calorie diet.{note ? ` ${note}` : ""}
      </p>
    </div>
  );
}
