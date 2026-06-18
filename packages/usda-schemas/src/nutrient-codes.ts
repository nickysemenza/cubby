import type { NutrientsPer100 } from "./schemas";

/**
 * Tier 1 nutrients - essential nutrients with 95%+ food coverage in USDA database.
 * Keys are human-readable identifiers, codes are USDA nutrient_nbr values.
 */
export const TIER1_NUTRIENTS = {
  // Macronutrients
  protein: { code: "203", unit: "G", displayName: "Protein" },
  fat: { code: "204", unit: "G", displayName: "Total Fat" },
  carbs: { code: "205", unit: "G", displayName: "Carbohydrates" },
  fiber: { code: "291", unit: "G", displayName: "Fiber" },
  kcal: { code: "208", unit: "KCAL", displayName: "Calories" },

  // Minerals
  calcium: { code: "301", unit: "MG", displayName: "Calcium" },
  iron: { code: "303", unit: "MG", displayName: "Iron" },
  magnesium: { code: "304", unit: "MG", displayName: "Magnesium" },
  potassium: { code: "306", unit: "MG", displayName: "Potassium" },
  sodium: { code: "307", unit: "MG", displayName: "Sodium" },
  zinc: { code: "309", unit: "MG", displayName: "Zinc" },
  selenium: { code: "317", unit: "UG", displayName: "Selenium" },

  // Vitamins
  vitamin_a: { code: "320", unit: "UG", displayName: "Vitamin A" },
  vitamin_d: { code: "328", unit: "UG", displayName: "Vitamin D" },
  vitamin_e: { code: "323", unit: "MG", displayName: "Vitamin E" },
  vitamin_k: { code: "430", unit: "UG", displayName: "Vitamin K" },
  vitamin_c: { code: "401", unit: "MG", displayName: "Vitamin C" },
  vitamin_b6: { code: "415", unit: "MG", displayName: "Vitamin B6" },
  vitamin_b12: { code: "418", unit: "UG", displayName: "Vitamin B12" },
  folate: { code: "417", unit: "UG", displayName: "Folate" },

  // Health indicators
  cholesterol: { code: "601", unit: "MG", displayName: "Cholesterol" },
  saturated_fat: { code: "606", unit: "G", displayName: "Saturated Fat" },
} as const;

export type NutrientKey = keyof typeof TIER1_NUTRIENTS;

export type NutrientInfo = (typeof TIER1_NUTRIENTS)[NutrientKey];

/**
 * Array of all tier 1 nutrient codes for filtering database queries.
 */
export const TIER1_CODES = Object.values(TIER1_NUTRIENTS).map(
  (n) => n.code,
) as string[];

/**
 * Lookup map from nutrient code to nutrient info.
 */
const CODE_TO_NUTRIENT: Record<string, NutrientInfo> = Object.fromEntries(
  Object.values(TIER1_NUTRIENTS).map((n) => [n.code, n]),
);

/**
 * Lookup map from nutrient code to nutrient key.
 */
const CODE_TO_KEY: Record<string, NutrientKey> = Object.fromEntries(
  Object.entries(TIER1_NUTRIENTS).map(([key, n]) => [
    n.code,
    key as NutrientKey,
  ]),
);

/**
 * Get the unit for a nutrient code (e.g., "203" -> "G").
 * Returns "G" as fallback for unknown codes.
 */
export function getNutrientUnit(code: string): string {
  return CODE_TO_NUTRIENT[code]?.unit ?? "G";
}

/**
 * Get the key (identifier) for a nutrient code (e.g., "203" -> "protein").
 * Returns the code itself as fallback for unknown codes.
 */
export function getNutrientKey(code: string): string {
  return CODE_TO_KEY[code] ?? code;
}

/**
 * Get the display name for a nutrient code (e.g., "203" -> "Protein").
 * Returns the key as fallback for unknown codes.
 */
export function getNutrientDisplayName(code: string): string {
  return CODE_TO_NUTRIENT[code]?.displayName ?? getNutrientKey(code);
}

/**
 * Get full nutrient info for a code, or undefined if not a tier 1 nutrient.
 */
export function getNutrientInfo(code: string): NutrientInfo | undefined {
  return CODE_TO_NUTRIENT[code];
}

/**
 * Check if a nutrient code is a tier 1 nutrient.
 */
export function isTier1Nutrient(code: string): boolean {
  return code in CODE_TO_NUTRIENT;
}

// Re-export from schemas for convenience
export type { NutrientsPer100 } from "./schemas";

/**
 * Create an empty nutrients record.
 */
export function createEmptyNutrients(): NutrientsPer100 {
  return {};
}

/**
 * Get a specific nutrient value from a nutrients record.
 * Returns 0 if the nutrient is not present.
 */
export function getNutrientValue(
  nutrients: NutrientsPer100,
  code: string,
): number {
  return nutrients[code] ?? 0;
}

/**
 * Get a specific nutrient value by key (e.g., "protein", "kcal").
 * Returns 0 if the nutrient is not present.
 */
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
