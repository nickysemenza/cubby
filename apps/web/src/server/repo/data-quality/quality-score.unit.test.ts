import {
  type QualityTerm,
  scoreQualityTerms,
} from "@cubby/schemas/data-quality";
import { describe, expect, it } from "vitest";

const term = (
  state: QualityTerm["state"],
  overrides: Partial<Omit<QualityTerm, "state">> = {},
): QualityTerm => ({
  weight: 1,
  scoreCap: null,
  defect: false,
  state,
  ...overrides,
});

/**
 * Failure modes this core guards (SQL parity lives in
 * `quality-score.integration.test.ts`):
 * - nothing applicable reads as a perfect 100 instead of "not assessed";
 * - an unscored defect on a record with no weighted checks disappears;
 * - a light gap among heavy checks rounds to a displayed 100;
 * - a declared cap is ignored, or several caps do not take the minimum;
 * - an excepted or inapplicable check still caps the score;
 * - an exceptions-only record is indistinguishable from a clean 100.
 */
describe("scoreQualityTerms", () => {
  it("does not assess a record with no applicable checks", () => {
    expect(scoreQualityTerms([])).toMatchObject({
      score: null,
      status: "not_assessed",
    });
    expect(
      scoreQualityTerms([
        term("not_applicable"),
        term("satisfied", { weight: 0 }),
      ]),
    ).toMatchObject({ score: null, status: "not_assessed" });
  });

  it("keeps an unscored defect visible as a capped score", () => {
    expect(
      scoreQualityTerms([term("gap", { weight: 0, defect: true })]),
    ).toMatchObject({ score: 99, status: "defect", weightedScore: null });
    expect(
      scoreQualityTerms([term("gap", { weight: 0, scoreCap: 40 })]),
    ).toMatchObject({ score: 40, status: "needs_data" });
  });

  it("never lets an unresolved gap round to 100", () => {
    const result = scoreQualityTerms([
      term("satisfied", { weight: 999 }),
      term("gap", { weight: 1 }),
    ]);
    expect(result.weightedScore).toBe(99.9);
    expect(result.score).toBe(99);
    expect(Math.round(result.score!)).toBe(99);
    expect(result.score!.toFixed(1)).toBe("99.0");
  });

  it("applies the lowest cap among unresolved checks only", () => {
    expect(
      scoreQualityTerms([
        term("satisfied", { weight: 8 }),
        term("gap", { weight: 1, scoreCap: 60 }),
        term("gap", { weight: 1, scoreCap: 30 }),
        term("excepted", { weight: 1, scoreCap: 5 }),
        term("not_applicable", { weight: 1, scoreCap: 0 }),
      ]),
    ).toMatchObject({ weightedScore: 81.82, scoreCap: 30, score: 30 });
    // A cap above the weighted score does not raise it.
    expect(
      scoreQualityTerms([
        term("satisfied"),
        term("gap", { weight: 3, scoreCap: 90 }),
      ]),
    ).toMatchObject({ weightedScore: 25, score: 25 });
  });

  it("marks accepted exceptions instead of a plain complete", () => {
    expect(
      scoreQualityTerms([term("satisfied"), term("excepted")]),
    ).toMatchObject({ score: 100, status: "complete_with_exceptions" });
    expect(scoreQualityTerms([term("satisfied")])).toMatchObject({
      score: 100,
      status: "complete",
    });
  });

  it("ranks defect over missing data", () => {
    expect(
      scoreQualityTerms([term("gap"), term("gap", { defect: true })]).status,
    ).toBe("defect");
    expect(scoreQualityTerms([term("gap"), term("excepted")]).status).toBe(
      "needs_data",
    );
  });
});
