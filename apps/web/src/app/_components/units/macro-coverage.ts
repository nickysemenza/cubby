import type { UnitMapping } from "@cubby/schemas/unitmapping-responses";
import {
  getNutrientUnitString,
  MACRO_KEYS,
  type NutrientKey,
} from "@cubby/usda-schemas";

/**
 * Which macro nutrients (protein/fat/carbs/fiber/sodium) a product's unit graph
 * already carries — detected by matching a mapping endpoint against the
 * canonical nutrient target string (`getNutrientUnitString`, e.g. "g protein",
 * "mg sodium"), the exact string USDA synthesis writes. Presence-only: a macro
 * is a leaf conversion target, never a convertibility probe, so a stored
 * "0 g fiber" edge still counts — we *have* the datum.
 *
 * Shares `MACRO_KEYS` with the recipe nutrition table (`NutrientsSummary`), so
 * the panel's macro chips and that table read from one ordered list and can't
 * drift. Pure (no WASM) so it stays unit-testable.
 */
export function macroCoverage(mappings: UnitMapping[]): Set<NutrientKey> {
  const targets = new Map<string, NutrientKey>(
    MACRO_KEYS.map((k) => [getNutrientUnitString(k), k]),
  );
  const present = new Set<NutrientKey>();
  for (const m of mappings) {
    const a = targets.get(m.a.unit);
    if (a) present.add(a);
    const b = targets.get(m.b.unit);
    if (b) present.add(b);
  }
  return present;
}
