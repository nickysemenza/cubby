import {
  dataCheck,
  dataCheckEntity,
  dataCheckExemptible,
  dataCheckWeight,
  dataChecksByEntity,
  dataQualityExceptionEntities,
} from "@cubby/schemas/data-quality";
import { describe, expect, it } from "vitest";

import { exceptionReasonsFor } from "./exception-reasons";
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

  // Clients render the accept action from this list instead of restating the
  // server's allowed reasons, so a check that forbids exceptions must expose
  // none and an exemptible one must expose exactly the server's list.
  it("exposes the server's reason list only for exemptible checks", () => {
    const forbidden = dataCheck.options.find(
      (check) =>
        dataQualityExceptionEntities[dataCheckEntity[check]] &&
        !dataCheckExemptible[check],
    );
    expect(forbidden).toBeDefined();
    const result = buildQualityBreakdown(
      [first, forbidden!],
      [first, forbidden!],
      [],
    );
    expect(
      result.checks.map((check) =>
        check.exceptionReasons.map(({ reason }) => reason),
      ),
    ).toEqual([[...exceptionReasonsFor(first)], []]);
    expect(result.checks[0]!.exceptionReasons.length).toBeGreaterThan(0);
  });

  it("carries the recorded exception so a stale one can be cleared", () => {
    const stale = {
      check: second,
      reason: "unavailable",
      note: "Synthetic.",
      targetType: "product",
      targetId: "PRD-4K7M",
      state: "stale",
    } as const;
    const result = buildQualityBreakdown([second], [second], [], [stale]);
    expect(result.checks[0]).toMatchObject({
      state: "gap",
      exception: { reason: "unavailable", note: "Synthetic.", state: "stale" },
    });
  });
});
