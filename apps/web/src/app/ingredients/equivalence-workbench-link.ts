import type { CandidateEquivalence } from "@cubby/schemas/equivalences";

export type EquivalenceDraft = {
  fromValue: number;
  fromUnit: string;
  toValue: number;
  toUnit: string;
};

/** Preserve a harvested candidate as visible URL state for the workbench editor. */
export const equivalenceWorkbenchSearch = (
  candidate: CandidateEquivalence,
) => ({
  focus: candidate.ingredientId,
  equivalenceFromUnit: candidate.unitA,
  equivalenceToUnit: candidate.unitB,
  equivalenceToValue: candidate.medianRatio,
});

export const equivalenceDraftFromSearch = (search: {
  equivalenceFromUnit?: string;
  equivalenceToUnit?: string;
  equivalenceToValue?: number;
}): EquivalenceDraft | undefined => {
  const { equivalenceFromUnit, equivalenceToUnit, equivalenceToValue } = search;
  if (
    !equivalenceFromUnit ||
    !equivalenceToUnit ||
    equivalenceToValue == null ||
    !(equivalenceToValue > 0) ||
    !Number.isFinite(equivalenceToValue)
  ) {
    return undefined;
  }
  return {
    fromValue: 1,
    fromUnit: equivalenceFromUnit,
    toValue: equivalenceToValue,
    toUnit: equivalenceToUnit,
  };
};
