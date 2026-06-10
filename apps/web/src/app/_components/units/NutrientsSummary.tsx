import {
  getNutrientDisplayName,
  getNutrientUnit,
  type NutrientsPer100,
} from "@cubby/usda-schemas";

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

export function NutrientsSummary({
  nutrients,
  compact = false,
}: {
  nutrients: NutrientsPer100;
  compact?: boolean;
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
    <div className="flex flex-wrap gap-1 text-xs">
      {displayNutrients.map((code) => {
        const value = nutrients[code] ?? 0;
        const unit = getNutrientUnit(code).toLowerCase();
        const displayName = getNutrientDisplayName(code).toUpperCase();

        return (
          <span
            key={code}
            className="inline-flex items-baseline gap-1 whitespace-nowrap rounded-sm bg-muted px-1.5 py-0.5"
          >
            <span className="font-medium text-subtle">{displayName}</span>
            <span className="text-highlight">{value.toFixed(1)}</span>
            <span className="text-muted-foreground">{unit}</span>
          </span>
        );
      })}
    </div>
  );
}
