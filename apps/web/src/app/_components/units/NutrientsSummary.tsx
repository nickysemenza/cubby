import {
  getNutrientDisplayName,
  getNutrientUnit,
  type NutrientKey,
  type NutrientsPer100,
  TIER1_NUTRIENTS,
} from "@cubby/usda-schemas";
import { Row } from "~/components/layout";
import { cn } from "~/lib/utils";

// The key nutrients shown in summaries and the recipe table, in display order.
// A deliberate whitelist — only these appear, even when more nutrient data is
// present, to keep things scannable. Macros first, then the most diet-relevant
// extra. Codes derive from TIER1_NUTRIENTS by key (no raw nutrient_nbr lives
// here); `label` is the short table header — the one per-surface override of the
// long displayName. Single source of truth so summary and table can't drift.
const KEY_NUTRIENT_SHORT_LABELS = [
  ["kcal", "Cal"],
  ["protein", "Protein"],
  ["fat", "Fat"],
  ["carbs", "Carbs"],
  ["fiber", "Fiber"],
  ["sodium", "Sodium"],
] as const satisfies ReadonlyArray<readonly [NutrientKey, string]>;

export const KEY_NUTRIENTS = KEY_NUTRIENT_SHORT_LABELS.map(([key, label]) => ({
  code: TIER1_NUTRIENTS[key].code,
  label,
  // Lowercased display unit ("kcal" / "g" / "mg") for the table column subhead.
  unit: TIER1_NUTRIENTS[key].unit.toLowerCase(),
}));

const KEY_NUTRIENT_CODES = KEY_NUTRIENTS.map((n) => n.code);
const KEY_NUTRIENT_LABELS = new Map(
  KEY_NUTRIENTS.map((n) => [n.code, n.label]),
);

// Compact view shows kcal + protein only — derived, not raw code literals.
const COMPACT_CODES: readonly string[] = [
  TIER1_NUTRIENTS.kcal.code,
  TIER1_NUTRIENTS.protein.code,
];

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
    ? presentNutrients.filter((code) => COMPACT_CODES.includes(code))
    : presentNutrients;

  if (displayNutrients.length === 0) {
    return null;
  }

  return (
    <Row
      wrap
      className={cn(dense ? "gap-0.5 text-2xs" /* tight */ : "gap-1 text-xs")}
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
              dense ? "px-1 py-0" : "px-1.5 py-0.5" /* tight: nutrient chip */,
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
    </Row>
  );
}
