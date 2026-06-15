import {
  getNutrientDisplayName,
  getNutrientUnit,
  type NutrientsPer100,
} from "@cubby/usda-schemas";
import { cn } from "~/lib/utils";

// The key nutrients shown in summaries and the recipe table, in display order.
// A deliberate whitelist — only these appear, even when more nutrient data is
// present, to keep things scannable. Macros first, then the two most
// diet-relevant extras. `label` is the short header used by the table's
// per-nutrient columns. Single source of truth so the summary and table can't
// drift apart.
export const KEY_NUTRIENTS = [
  { code: "208", label: "Cal", unit: "kcal" },
  { code: "203", label: "Protein", unit: "g" },
  { code: "204", label: "Fat", unit: "g" },
  { code: "205", label: "Carbs", unit: "g" },
  { code: "291", label: "Fiber", unit: "g" },
  { code: "307", label: "Sodium", unit: "mg" },
] as const;

const KEY_NUTRIENT_CODES = KEY_NUTRIENTS.map((n) => n.code);
const KEY_NUTRIENT_LABELS = new Map(
  KEY_NUTRIENTS.map((n) => [n.code, n.label]),
);

// Trim trailing-zero decimals: 450.0 → "450", 11.7 → "11.7".
const trimAmount = (v: number) => Number(v.toFixed(1)).toString();

export function NutrientsSummary({
  nutrients,
  compact = false,
  dense = false,
}: {
  nutrients: NutrientsPer100;
  compact?: boolean;
  /** Tighter chips with short labels + trimmed decimals, for space-tight rows. */
  dense?: boolean;
}) {
  // Show only the key nutrients that are present in the data, in priority order.
  const presentNutrients = KEY_NUTRIENT_CODES.filter(
    (code) => nutrients[code] !== undefined && nutrients[code] > 0,
  );

  // In compact mode, only show kcal and protein
  const displayNutrients = compact
    ? presentNutrients.filter((code) => code === "208" || code === "203")
    : presentNutrients;

  if (displayNutrients.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex flex-wrap",
        dense ? "gap-0.5 text-2xs" : "gap-1 text-xs",
      )}
    >
      {displayNutrients.map((code) => {
        const value = nutrients[code] ?? 0;
        const unit = getNutrientUnit(code).toLowerCase();
        const displayName = dense
          ? (KEY_NUTRIENT_LABELS.get(code) ?? code).toUpperCase()
          : getNutrientDisplayName(code).toUpperCase();

        return (
          <span
            key={code}
            className={cn(
              "inline-flex items-baseline gap-1 whitespace-nowrap rounded-sm bg-muted",
              dense ? "px-1 py-0" : "px-1.5 py-0.5",
            )}
          >
            <span className="font-medium text-subtle">{displayName}</span>
            <span className="text-highlight">
              {dense ? trimAmount(value) : value.toFixed(1)}
            </span>
            <span className="text-muted-foreground">{unit}</span>
          </span>
        );
      })}
    </div>
  );
}
