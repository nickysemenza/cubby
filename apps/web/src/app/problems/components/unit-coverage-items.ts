import type { RouterOutputs } from "~/trpc/react";

// Pure, JSX-free core of the merged "Unit coverage" section, split out from
// unit-coverage-fix.tsx so it's unit-testable (a .unit.test.ts can't import a
// .tsx that pulls in `~/`-aliased React modules — see the vitest-unit-tsx-alias
// note). The card rendering + inline-fix forms stay in the .tsx.

type AllProblems = RouterOutputs["problems"]["getAllProblems"];
type NoMappings = AllProblems["productsWithoutMappings"][number];
type Islanded = AllProblems["productsWithIslandedMappings"][number];

/**
 * The two "can't fully convert" problems unified into one list: a product with
 * no conversion graph at all (`none`) or one fragmented into islands
 * (`islanded`). They share the inline fix (add conversions) and differ only in
 * the pre-fill hint, so they render in one "Unit coverage" section.
 */
export type UnitCoverageItem =
  | ({ kind: "none" } & NoMappings)
  | ({ kind: "islanded" } & Islanded);

/** Concatenate the two source arrays into the merged, discriminated list. */
export function buildUnitCoverageItems(
  noMappings: readonly NoMappings[],
  islanded: readonly Islanded[],
): UnitCoverageItem[] {
  return [
    ...noMappings.map((p) => ({ kind: "none" as const, ...p })),
    ...islanded.map((p) => ({ kind: "islanded" as const, ...p })),
  ];
}

/** Subgroup heading for an item — drives the section's `groupBy`. */
export function unitCoverageGroup(item: UnitCoverageItem): string {
  if (item.kind === "islanded") return "Disconnected";
  return item.isIngredient
    ? "No conversions · ingredient"
    : "No conversions · other";
}
