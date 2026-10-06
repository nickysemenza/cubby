import type { DataQualityStatus } from "./data-quality-shape";

/**
 * The cap every unresolved check imposes when it declares no `scoreCap`, so
 * a gap never rounds to a displayed 100 (whole or one decimal).
 */
export const DEFAULT_UNRESOLVED_SCORE_CAP = 99;

/** One applicable-or-not check of one record, as both TS and SQL score it. */
export type QualityTerm = {
  /** 0 for an unscored diagnostic. */
  weight: number;
  /** Declared cap; null takes `DEFAULT_UNRESOLVED_SCORE_CAP`. */
  scoreCap: number | null;
  defect: boolean;
  state: "not_applicable" | "satisfied" | "gap" | "excepted";
};

export type QualityScore = {
  /** The weighted score after caps; null when not assessed. */
  score: number | null;
  /** `satisfied ÷ applicable weight`, before caps; null when no weight applies. */
  weightedScore: number | null;
  /** The lowest cap among unresolved checks; null when nothing is unresolved. */
  scoreCap: number | null;
  expectedWeight: number;
  satisfiedWeight: number;
  status: DataQualityStatus;
};

/**
 * The one scoring rule; `scoreFromStates`/`statusFromStates` in the web
 * repo's `data-quality/sql.ts` spell it in SQL. Active exceptions count as
 * satisfied and never cap. Every unresolved check, weighted or not, caps the
 * score at its `scoreCap`; with no applicable weight the cap alone is the
 * score, and with no unresolved check either the record is not assessed.
 */
export const scoreQualityTerms = (
  terms: readonly QualityTerm[],
): QualityScore => {
  const applicable = terms.filter((term) => term.state !== "not_applicable");
  const gaps = applicable.filter((term) => term.state === "gap");
  const expectedWeight = applicable.reduce((sum, term) => sum + term.weight, 0);
  const satisfiedWeight = applicable.reduce(
    (sum, term) => (term.state === "gap" ? sum : sum + term.weight),
    0,
  );
  const weightedScore =
    expectedWeight === 0
      ? null
      : Math.round((satisfiedWeight / expectedWeight) * 10_000) / 100;
  const scoreCap =
    gaps.length === 0
      ? null
      : Math.min(
          ...gaps.map((term) => term.scoreCap ?? DEFAULT_UNRESOLVED_SCORE_CAP),
        );
  const score =
    scoreCap === null
      ? weightedScore
      : weightedScore === null
        ? scoreCap
        : Math.min(weightedScore, scoreCap);
  const status: DataQualityStatus = gaps.some((term) => term.defect)
    ? "defect"
    : gaps.length > 0
      ? "needs_data"
      : expectedWeight === 0
        ? "not_assessed"
        : applicable.some((term) => term.state === "excepted")
          ? "complete_with_exceptions"
          : "complete";
  return {
    score,
    weightedScore,
    scoreCap,
    expectedWeight,
    satisfiedWeight,
    status,
  };
};
