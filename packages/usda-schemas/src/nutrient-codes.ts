import type { NutrientsPer100 } from "./schemas";

/**
 * Tier 1 nutrients - essential nutrients with 95%+ food coverage in USDA database.
 * Keys are human-readable identifiers, codes are USDA nutrient_nbr values.
 */
export const TIER1_NUTRIENTS = {
  protein: { code: "203", unit: "G", displayName: "Protein" },
  fat: { code: "204", unit: "G", displayName: "Total Fat" },
  carbs: { code: "205", unit: "G", displayName: "Carbohydrates" },
  fiber: { code: "291", unit: "G", displayName: "Fiber" },
  kcal: { code: "208", unit: "KCAL", displayName: "Calories" },

  calcium: { code: "301", unit: "MG", displayName: "Calcium" },
  iron: { code: "303", unit: "MG", displayName: "Iron" },
  magnesium: { code: "304", unit: "MG", displayName: "Magnesium" },
  potassium: { code: "306", unit: "MG", displayName: "Potassium" },
  sodium: { code: "307", unit: "MG", displayName: "Sodium" },
  zinc: { code: "309", unit: "MG", displayName: "Zinc" },
  selenium: { code: "317", unit: "UG", displayName: "Selenium" },

  vitamin_a: { code: "320", unit: "UG", displayName: "Vitamin A" },
  vitamin_d: { code: "328", unit: "UG", displayName: "Vitamin D" },
  vitamin_e: { code: "323", unit: "MG", displayName: "Vitamin E" },
  vitamin_k: { code: "430", unit: "UG", displayName: "Vitamin K" },
  vitamin_c: { code: "401", unit: "MG", displayName: "Vitamin C" },
  vitamin_b6: { code: "415", unit: "MG", displayName: "Vitamin B6" },
  vitamin_b12: { code: "418", unit: "UG", displayName: "Vitamin B12" },
  folate: { code: "417", unit: "UG", displayName: "Folate" },

  cholesterol: { code: "601", unit: "MG", displayName: "Cholesterol" },
  saturated_fat: { code: "606", unit: "G", displayName: "Saturated Fat" },
} as const;

export type NutrientKey = keyof typeof TIER1_NUTRIENTS;

export type NutrientInfo = (typeof TIER1_NUTRIENTS)[NutrientKey];

export const TIER1_CODES = Object.values(TIER1_NUTRIENTS).map(
  (n) => n.code,
) as string[];

/**
 * The key nutrients shown in summaries, the recipe table, and the unit-mapping
 * macro chips, in display order. A deliberate whitelist — only these appear,
 * even when more nutrient data is present, so those surfaces stay scannable and
 * never drift. Macros first, then the most diet-relevant extra. The single
 * source of truth for that ordered membership (presentation labels stay
 * per-surface; see `NutrientsSummary`).
 */
export const KEY_NUTRIENT_KEYS = [
  "kcal",
  "protein",
  "fat",
  "carbs",
  "fiber",
  "sodium",
] as const satisfies ReadonlyArray<NutrientKey>;

/**
 * The macro nutrients a unit-mapping graph can carry as `nutrient:*` edges — the
 * key nutrients minus `kcal`, which is already the base measurement kind
 * `calories`. Drives the unit-mapping panel's macro-coverage chips, so the chips
 * and the recipe table read from one ordered list.
 */
export const MACRO_KEYS: readonly NutrientKey[] = KEY_NUTRIENT_KEYS.filter(
  (k) => k !== "kcal",
);

const CODE_TO_NUTRIENT: Record<string, NutrientInfo> = Object.fromEntries(
  Object.values(TIER1_NUTRIENTS).map((n) => [n.code, n]),
);

const CODE_TO_KEY: Record<string, NutrientKey> = Object.fromEntries(
  Object.entries(TIER1_NUTRIENTS).map(([key, n]) => [
    n.code,
    key as NutrientKey,
  ]),
);

export function getNutrientUnit(code: string): string {
  return CODE_TO_NUTRIENT[code]?.unit ?? "G";
}

export function getNutrientKey(code: string): string {
  return CODE_TO_KEY[code] ?? code;
}

export function getNutrientDisplayName(code: string): string {
  return CODE_TO_NUTRIENT[code]?.displayName ?? getNutrientKey(code);
}

export function getNutrientInfo(code: string): NutrientInfo | undefined {
  return CODE_TO_NUTRIENT[code];
}

export function isTier1Nutrient(code: string): boolean {
  return code in CODE_TO_NUTRIENT;
}

export type { NutrientsPer100 } from "./schemas";

export function createEmptyNutrients(): NutrientsPer100 {
  return {};
}

export function getNutrientValue(
  nutrients: NutrientsPer100,
  code: string,
): number {
  return nutrients[code] ?? 0;
}

export function getNutrientValueByKey(
  nutrients: NutrientsPer100,
  key: NutrientKey,
): number {
  const code = TIER1_NUTRIENTS[key].code;
  return getNutrientValue(nutrients, code);
}

/**
 * Build a nutrients record from human-readable keys — the inverse of
 * {@link getNutrientValueByKey}. e.g. `{ protein: 7.2, fat: 3.1 }` →
 * `{ "203": 7.2, "204": 3.1 }`. Entries with a falsy value (0 / undefined) are
 * dropped, so callers never have to hand-write USDA code strings or filter
 * empties themselves.
 */
export function buildNutrients(
  values: Partial<Record<NutrientKey, number | undefined>>,
): NutrientsPer100 {
  const out: NutrientsPer100 = {};
  for (const [key, value] of Object.entries(values)) {
    if (value) out[TIER1_NUTRIENTS[key as NutrientKey].code] = value;
  }
  return out;
}

/**
 * Get the canonical unit string for a nutrient (e.g., "g protein", "kcal").
 * Used by both mapping creation and conversion targets.
 * Avoids duplication like "kcal kcal" - uses just the unit when they match.
 */
export function getNutrientUnitString(key: NutrientKey): string {
  const info = TIER1_NUTRIENTS[key];
  const unit = info.unit.toLowerCase();
  return unit === key ? unit : `${unit} ${key}`;
}

/** FDA adult Daily Values (21 CFR 101.9(c), 2016 rule), in each nutrient's TIER1 unit
 * (vitamin A µg RAE, folate µg DFE — matching USDA codes 320/417).
 * kcal's 2000 is the label footnote reference amount, not a %DV. Every TIER1
 * nutrient has an official 2016-rule DV, so this is a total `Record` — no
 * `Partial` needed. */
export const DAILY_VALUES: Record<NutrientKey, number> = {
  protein: 50,
  fat: 78,
  carbs: 275,
  fiber: 28,
  kcal: 2000,
  calcium: 1300,
  iron: 18,
  magnesium: 420,
  potassium: 4700,
  sodium: 2300,
  zinc: 11,
  selenium: 55,
  vitamin_a: 900,
  vitamin_d: 20,
  vitamin_e: 15,
  vitamin_k: 120,
  vitamin_c: 90,
  vitamin_b6: 1.7,
  vitamin_b12: 2.4,
  folate: 400,
  cholesterol: 300,
  saturated_fat: 20,
};

/**
 * A nutrient amount's percent Daily Value, FDA label style (e.g. 18g fat →
 * 23%). Callers omit %DV for `kcal` themselves — its DV entry is the label's
 * reference-amount footnote, not a percentage.
 */
export const dailyValuePct = (key: NutrientKey, amount: number): number =>
  (amount / DAILY_VALUES[key]) * 100;
