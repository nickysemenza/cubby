import {
  type NutrientsPer100,
  TIER1_NUTRIENTS,
  getNutrientDisplayName,
  getNutrientUnit,
} from "@recipehub/usda-schemas";

// Priority order for display - show macros first, then minerals, then vitamins
const DISPLAY_ORDER = [
  "208", // kcal
  "203", // protein
  "204", // fat
  "205", // carbs
  "291", // fiber
  "307", // sodium
  "601", // cholesterol
  "606", // saturated fat
] as const;

// Get all nutrient codes in display order (priority codes first, then rest)
const getOrderedNutrientCodes = (): string[] => {
  const allCodes = Object.values(TIER1_NUTRIENTS).map((n) => n.code);
  const priorityCodes = new Set<string>(DISPLAY_ORDER);
  const remainingCodes = allCodes.filter((code) => !priorityCodes.has(code));
  return [...DISPLAY_ORDER, ...remainingCodes];
};

export function NutrientsSummary({
  nutrients,
  compact = false,
}: {
  nutrients: NutrientsPer100;
  compact?: boolean;
}) {
  const orderedCodes = getOrderedNutrientCodes();

  // Filter to only nutrients present in the data
  const presentNutrients = orderedCodes.filter(
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
    <div className="space-y-1 text-xs">
      {displayNutrients.map((code) => {
        const value = nutrients[code] ?? 0;
        const unit = getNutrientUnit(code).toLowerCase();
        const displayName = getNutrientDisplayName(code).toUpperCase();

        return (
          <div key={code} className="border border-muted px-2 py-1">
            <span className="font-medium text-chart-2">{displayName}:</span>{" "}
            <span className="text-chart-1">{value.toFixed(1)}</span>{" "}
            <span className="text-muted-foreground">{unit}</span>
          </div>
        );
      })}
    </div>
  );
}
