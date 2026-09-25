import { describe, expect, it } from "vitest";

import { scoreProposals } from "./flue-model-eval.score";

const expected = [
  { photos: ["a", "b"], match: { kind: "create" as const } },
  { photos: ["c"], match: { kind: "existing" as const, product: "p1" } },
];

describe("scoreProposals", () => {
  it("scores an exact answer as a full pass", () => {
    const score = scoreProposals(
      expected,
      ["a", "b", "c"],
      [
        { photos: ["a", "b"], product: null },
        { photos: ["c"], product: "p1" },
      ],
    );
    expect(score).toMatchObject({
      exact: true,
      pairF1: 1,
      matchAccuracy: 1,
      uncovered: [],
      duplicated: [],
    });
  });

  it("penalizes a merge of distinct items and a wrong existing match", () => {
    const score = scoreProposals(
      expected,
      ["a", "b", "c"],
      [{ photos: ["a", "b", "c"], product: "p2" }],
    );
    expect(score.exact).toBe(false);
    // Proposed pairs ab, ac, bc; only ab is expected.
    expect(score.pairF1).toBeCloseTo(0.5);
    expect(score.matchAccuracy).toBe(0);
  });

  it("reports photos left out or proposed twice", () => {
    const score = scoreProposals(
      expected,
      ["a", "b", "c"],
      [
        { photos: ["a", "b"], product: null },
        { photos: ["b"], product: null },
      ],
    );
    expect(score.uncovered).toEqual(["c"]);
    expect(score.duplicated).toEqual(["b"]);
    expect(score.exact).toBe(false);
  });

  it("accepts any outcome but the forbidden variant for notExisting", () => {
    const trap = [
      { photos: ["x"], match: { kind: "notExisting" as const, product: "L" } },
    ];
    expect(
      scoreProposals(trap, ["x"], [{ photos: ["x"], product: null }])
        .matchAccuracy,
    ).toBe(1);
    expect(
      scoreProposals(trap, ["x"], [{ photos: ["x"], product: "L" }])
        .matchAccuracy,
    ).toBe(0);
  });
});
