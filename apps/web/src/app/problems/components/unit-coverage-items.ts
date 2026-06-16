import type { RouterOutputs } from "~/trpc/react";

// Pure, JSX-free core of the merged "Unit coverage" section, split out from
// unit-coverage-fix.tsx so it's unit-testable (a .unit.test.ts can't import a
// .tsx that pulls in `~/`-aliased React modules — see the vitest-unit-tsx-alias
// note). The card rendering + inline-fix forms stay in the .tsx.

type AllProblems = RouterOutputs["problems"]["getAllProblems"];
type NoMappings = AllProblems["productsWithoutMappings"][number];
type Islanded = AllProblems["productsWithIslandedMappings"][number];
type PartialCoverage = AllProblems["ingredientsWithPartialCoverage"][number];

/**
 * The "can't fully convert" problems unified into one list: a product with no
 * conversion graph at all (`none`), an ingredient that has only a price so it
 * can reach nothing but money (`partial`), or one fragmented into islands
 * (`islanded`). They share the inline fix (add conversions) and differ only in
 * the pre-fill hint, so they render in one "Unit coverage" section.
 */
export type UnitCoverageItem =
  | ({ kind: "none" } & NoMappings)
  | ({ kind: "partial" } & PartialCoverage)
  | ({ kind: "islanded" } & Islanded);

/** Concatenate the source arrays into the merged, discriminated list. */
export function buildUnitCoverageItems(
  noMappings: readonly NoMappings[],
  partial: readonly PartialCoverage[],
  islanded: readonly Islanded[],
): UnitCoverageItem[] {
  return [
    ...noMappings.map((p) => ({ kind: "none" as const, ...p })),
    ...partial.map((p) => ({ kind: "partial" as const, ...p })),
    ...islanded.map((p) => ({ kind: "islanded" as const, ...p })),
  ];
}

// USDA fills these three; if they're all covered the USDA-link step is moot.
const coversWeightVolumeCalories = (covered: readonly string[]): boolean =>
  ["weight", "volume", "calories"].every((k) => covered.includes(k));

/** Which inline-fix steps an ingredient card should offer, given its coverage. */
export interface IngredientFixSteps {
  /** Offer the USDA search (+ "no USDA" mark) — only when a link could still help. */
  showUsda: boolean;
  /** Offer the free-form "<qty> <unit> = <qty> <unit>" conversion (the universal connector). */
  showManual: boolean;
  /** Offer the "<qty> <unit> = $<price>" step — only when no price exists yet. */
  showPrice: boolean;
  /** Offer the "100 g = N kcal" step — for a food USDA can't supply calories for. */
  showCalories: boolean;
  /** Show the "no USDA entry exists" action that flips to manual mode. */
  allowMarkNoUsda: boolean;
}

/**
 * Decide the inline-fix steps for an under-covered ingredient (the `partial`
 * kind, and `none` ingredients which are just `partial` with empty coverage:
 * their DB filter guarantees no price/NDB/UPC/mappings, so `covered=[]`,
 * `hasPrice=false`, `hasUsdaLink=false`). Pure so it's unit-testable.
 *
 * - Offer the USDA search only when a link could still fill a gap: not already
 *   linked, not marked unavailable, and weight/volume/calories aren't all covered.
 * - When USDA can't help (linked, or marked no-USDA), guide manual entry instead:
 *   the free-form conversion (covers a missing volume *and* bridges an islanded
 *   each-price to grams) plus a calorie step if calories are still missing.
 * - Always offer the price step when there's no price (never blank-overwrite one).
 */
export function ingredientFixSteps({
  covered,
  hasPrice,
  hasUsdaLink,
  usdaUnavailable,
}: {
  covered: readonly string[];
  hasPrice: boolean;
  hasUsdaLink: boolean;
  usdaUnavailable: boolean;
}): IngredientFixSteps {
  const showUsda =
    !hasUsdaLink && !usdaUnavailable && !coversWeightVolumeCalories(covered);
  return {
    showUsda,
    showManual: !showUsda,
    showPrice: !hasPrice,
    showCalories: !showUsda && !covered.includes("calories"),
    allowMarkNoUsda: showUsda,
  };
}

/** Subgroup heading for an item — drives the section's `groupBy`. */
export function unitCoverageGroup(item: UnitCoverageItem): string {
  if (item.kind === "islanded") return "Disconnected";
  if (item.kind === "partial") return "Incomplete coverage";
  return item.isIngredient
    ? "No conversions · ingredient"
    : "No conversions · other";
}
