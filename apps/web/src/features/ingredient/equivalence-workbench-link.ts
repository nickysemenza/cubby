import type { CandidateEquivalence } from "@cubby/schemas/equivalences";

export type EquivalenceDraft = {
  fromValue: number;
  fromUnit: string;
  toValue: number;
  toUnit: string;
};

export const enrichmentWorkbenchQueryInput = ({
  focus,
  recipeId,
  initialConversion,
}: {
  focus?: string;
  recipeId?: string;
  initialConversion?: EquivalenceDraft;
}): { recipeId?: string; focusId?: string } | undefined => {
  if (recipeId) return { recipeId };
  // Problems-page links also carry `focus`, but they intentionally load the
  // whole worklist and scroll to one row. Only equivalence links carry a draft
  // and need the server to include a fully-covered conflicting ingredient.
  if (focus && initialConversion) return { focusId: focus };
  return undefined;
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
