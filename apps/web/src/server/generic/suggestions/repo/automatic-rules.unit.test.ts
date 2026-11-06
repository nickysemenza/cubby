import { describe, expect, it } from "vitest";

import { matchFieldRules } from "./automatic-policy";

// Failure modes: correcting a populated member field never matches, or broadening
// assignments silently admits pruning, undeclared fields, or review-required fields.
describe("field.addition", () => {
  const facts = {
    entity: "product" as const,
    field: "categoryId",
    kind: "addition",
    confidence: 0.97,
    model: "typesafe/jev",
  };

  // Failure: a confident correction overwrites a member value, or ordinary
  // additions remain gated on a Sweep model rather than current evidence.
  it("matches only high-confidence additions without requiring a Sweep", () => {
    expect(matchFieldRules(facts)[0]?.key).toBe("field.addition");
    expect(matchFieldRules({ ...facts, confidence: 0.88 })[0]?.key).toBe(
      "field.addition",
    );
    expect(matchFieldRules({ ...facts, kind: "correction" })).toEqual([]);
    expect(matchFieldRules({ ...facts, confidence: 0.849 })).toEqual([]);
    expect(matchFieldRules({ ...facts, confidence: 0.85 })[0]?.key).toBe(
      "field.addition",
    );
  });

  it("keeps review-required fields and pruning out of automatic assignments", () => {
    expect(
      matchFieldRules({ ...facts, entity: "expense", field: "lineKind" }),
    ).toEqual([]);
    expect(matchFieldRules({ ...facts, field: "tags" })).toEqual([]);
    expect(matchFieldRules({ ...facts, field: "undeclared" })).toEqual([]);
  });
});
