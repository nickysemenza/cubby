import {
  dataCheckWeight,
  dataChecksByEntity,
} from "@cubby/schemas/data-quality";
import { describe, expect, it } from "vitest";

import { buildQualityBreakdown, calculateDataQualityScore } from "./hydrate";

// The explanation must use applicability, rather than all declared checks;
// active exceptions satisfy a check, stale exceptions do not, and unrelated
// gaps must never reduce this record's score.
describe("quality explanation calculation", () => {
  const first = dataChecksByEntity.product.enum.product_category;
  const second = dataChecksByEntity.product.enum.product_image;

  it("reconciles the displayed weights with the canonical score", () => {
    const result = buildQualityBreakdown([first, second], [second], []);
    expect(result.score).toBe(
      calculateDataQualityScore([first, second], [{ check: second }]),
    );
    expect(result.expectedWeight).toBe(
      dataCheckWeight[first] + dataCheckWeight[second],
    );
    expect(result.satisfiedWeight).toBe(dataCheckWeight[first]);
    expect(result.checks.map((check) => check.state)).toEqual([
      "satisfied",
      "gap",
    ]);
  });

  it("distinguishes accepted gaps from stale exceptions", () => {
    const result = buildQualityBreakdown([first, second], [second], [first]);
    expect(result.checks.map((check) => check.state)).toEqual([
      "excepted",
      "gap",
    ]);
    expect(result.score).toBeLessThan(100);
  });

  it("does not penalize inapplicable checks and explains the empty denominator", () => {
    const result = buildQualityBreakdown([], [first], []);
    expect(result).toMatchObject({
      score: 100,
      expectedWeight: 0,
      satisfiedWeight: 0,
      checks: [],
    });
  });
});
