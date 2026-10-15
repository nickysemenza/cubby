import type { AllProblems } from "@cubby/schemas/problems";

// Pure, JSX-free core of the merged "Unit coverage" section, split out from
// unit-coverage-fix.tsx so it's unit-testable (a .unit.test.ts can't import a
// .tsx that pulls in `~/`-aliased React modules — see the vitest-unit-tsx-alias
// note). The card rendering + inline-fix forms stay in the .tsx.

type NoMappings = AllProblems["productsWithoutMappings"][number];
type Islanded = AllProblems["productsWithIslandedMappings"][number];
type PartialCoverage = AllProblems["ingredientsWithPartialCoverage"][number];
type TitleSize = AllProblems["productsWithTitleDerivableSize"][number];

/**
 * The "can't fully convert" problems unified into one list: a product with no
 * conversion graph at all (`none`), an ingredient that has only a price so it
 * can reach nothing but money (`partial`), one fragmented into islands
 * (`islanded`), or one whose own title already states the size it is missing
 * (`titleSize`). They share the inline fix (add conversions) and differ only in
 * the pre-fill hint, so they render in one "Unit coverage" section.
 *
 * `titleSize` is the only one of the four classed `coverage` rather than
 * `defect` — it is a ~1,400-row enrichment backlog that new products keep
 * refilling, not something driven to zero.
 */
export type UnitCoverageItem =
  | ({ kind: "none" } & NoMappings)
  | ({ kind: "partial" } & PartialCoverage)
  | ({ kind: "islanded" } & Islanded)
  | ({ kind: "titleSize" } & TitleSize);

/** Concatenate the source arrays into the merged, discriminated list. */
export function buildUnitCoverageItems(
  noMappings: readonly NoMappings[],
  partial: readonly PartialCoverage[],
  islanded: readonly Islanded[],
  titleSized: readonly TitleSize[] = [],
): UnitCoverageItem[] {
  return [
    ...noMappings.map((p) => ({ kind: "none" as const, ...p })),
    ...partial.map((p) => ({ kind: "partial" as const, ...p })),
    ...islanded.map((p) => ({ kind: "islanded" as const, ...p })),
    ...titleSized.map((p) => ({ kind: "titleSize" as const, ...p })),
  ];
}

/** Subgroup heading for an item — drives the section's `groupBy`. */
export function unitCoverageGroup(item: UnitCoverageItem): string {
  if (item.kind === "islanded") return "Disconnected";
  if (item.kind === "partial") return "Incomplete coverage";
  if (item.kind === "titleSize") return "Size is in the title";
  return item.isIngredient
    ? "No conversions · ingredient"
    : "No conversions · other";
}
