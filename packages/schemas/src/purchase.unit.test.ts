import { describe, expect, it } from "vitest";
import {
  deleteEmptyPurchasesInput,
  purchaseFilterFields,
  RECONCILIATION_TOLERANCE,
  reconcilePurchase,
  splitExpenseDelta,
  splitExpenseInput,
} from "./purchase";

describe("purchase filter terminology", () => {
  it("exposes expenseStatus and removes the old lineStatus field", () => {
    expect(purchaseFilterFields).toHaveProperty("expenseStatus");
    expect(purchaseFilterFields).not.toHaveProperty("lineStatus");
  });

  it("exposes the structured trio for every curated related column", () => {
    for (const relation of [
      "expense",
      "financialTransaction",
      "product",
      "project",
    ]) {
      expect(purchaseFilterFields).toHaveProperty(`${relation}Id`);
      expect(purchaseFilterFields).toHaveProperty(`${relation}PresenceFilter`);
      expect(purchaseFilterFields).toHaveProperty(`${relation}Search`);
    }
  });
});

describe("purchase operation inputs", () => {
  it("requires a unique bounded delete-empty selection", () => {
    expect(
      deleteEmptyPurchasesInput.safeParse({ ids: ["PUR-6662"] }).success,
    ).toBe(true);
    expect(
      deleteEmptyPurchasesInput.safeParse({
        ids: ["PUR-6662", "PUR-6662"],
      }).success,
    ).toBe(false);
  });

  it("distinguishes inherited, replaced, and cleared split notes", () => {
    const parsed = splitExpenseInput.parse({
      expenseId: "EXP-6662",
      parts: [
        {
          name: "inherit",
          cost: 1,
          costType: "materials",
          trade: "other",
        },
        {
          name: "replace",
          cost: 1,
          costType: "materials",
          trade: "other",
          notes: "line evidence",
        },
        {
          name: "clear",
          cost: 1,
          costType: "materials",
          trade: "other",
          notes: null,
        },
      ],
    });

    expect(parsed.parts.map((part) => part.notes)).toEqual([
      undefined,
      "line evidence",
      null,
    ]);
  });
});

/**
 * The single verdict function behind the charge list column, the charge detail
 * reconciliation strip, and the Problems detector — so all three agree by
 * construction. Nothing here rejects a write or back-computes a cost: a mismatch
 * is a SOFT flag, and is often correct (a partial refund reduces a line without
 * changing what the paperwork claimed).
 */
describe("reconcilePurchase", () => {
  it('is "unknown" when no statedTotal has been recorded', () => {
    // Distinct from a $0 stated total, which IS a claim and gets compared.
    expect(reconcilePurchase({ statedTotal: null, expenseTotal: 0 })).toBe(
      "unknown",
    );
    expect(reconcilePurchase({ statedTotal: null, expenseTotal: 149.99 })).toBe(
      "unknown",
    );
    expect(reconcilePurchase({ statedTotal: 0, expenseTotal: 0 })).toBe(
      "match",
    );
  });

  it("matches an exact agreement and flags a real disagreement", () => {
    expect(reconcilePurchase({ statedTotal: 2516, expenseTotal: 2516 })).toBe(
      "match",
    );
    expect(reconcilePurchase({ statedTotal: 2516, expenseTotal: 2400 })).toBe(
      "mismatch",
    );
    // Direction-agnostic — the lines may overshoot the stated total too.
    expect(reconcilePurchase({ statedTotal: 2400, expenseTotal: 2516 })).toBe(
      "mismatch",
    );
  });

  it("recognizes only fully-priced negative differences explained by posted refunds", () => {
    expect(
      reconcilePurchase({
        statedTotal: 326.36,
        expenseTotal: 199.26,
        unpricedExpenseCount: 0,
        postedRefundTotal: -127.1,
      }),
    ).toBe("refund_adjusted");
    expect(
      reconcilePurchase({
        statedTotal: 326.36,
        expenseTotal: 199.26,
        unpricedExpenseCount: 1,
        postedRefundTotal: -127.1,
      }),
    ).toBe("mismatch");
    expect(
      reconcilePurchase({
        statedTotal: 199.26,
        expenseTotal: 326.36,
        unpricedExpenseCount: 0,
        postedRefundTotal: 127.1,
      }),
    ).toBe("mismatch");
  });

  it("sums refund evidence before classification and compares in cents", () => {
    expect(
      reconcilePurchase({
        statedTotal: 100,
        expenseTotal: 79.99,
        postedRefundTotal: -10.005 + -10.005,
      }),
    ).toBe("refund_adjusted");
    expect(
      reconcilePurchase({
        statedTotal: 100,
        expenseTotal: 80,
        postedRefundTotal: 20,
      }),
    ).toBe("mismatch");
    expect(
      reconcilePurchase({
        statedTotal: 100,
        expenseTotal: 80,
        postedRefundTotal: -19.99,
      }),
    ).toBe("mismatch");
  });

  it("absorbs sub-penny float drift and flags anything past the tolerance", () => {
    // Why the tolerance exists at all: summing float line costs rarely lands
    // exactly on the vendor's stated total.
    expect(
      reconcilePurchase({
        statedTotal: 100,
        expenseTotal: 100 - RECONCILIATION_TOLERANCE / 2,
      }),
    ).toBe("match");
    expect(
      reconcilePurchase({
        statedTotal: 100,
        expenseTotal: 100 + RECONCILIATION_TOLERANCE / 2,
      }),
    ).toBe("match");

    // The boundary IS inclusive, at every magnitude. This is only assertable
    // because `reconcilePurchase` compares in cents — the raw float difference
    // `Math.abs(100 - (100 - 0.01))` is 0.010000000000005116 and would fail a
    // plain `<= 0.01`, which used to make the verdict depend on magnitude. Both
    // cases below are a nominal one-cent gap and both must match.
    expect(Math.abs(100 - (100 - RECONCILIATION_TOLERANCE))).toBeGreaterThan(
      RECONCILIATION_TOLERANCE,
    );
    expect(
      reconcilePurchase({
        statedTotal: 100,
        expenseTotal: 100 - RECONCILIATION_TOLERANCE,
      }),
    ).toBe("match");
    expect(
      reconcilePurchase({ statedTotal: 431.24, expenseTotal: 431.23 }),
    ).toBe("match");

    // Anything a human would call a discrepancy is flagged.
    expect(reconcilePurchase({ statedTotal: 100, expenseTotal: 99.97 })).toBe(
      "mismatch",
    );
  });
});

/**
 * The MCP `split_expense` cue: `originalCost`/`partsSum`/`delta`. A cue, not a
 * gate — `splitExpense` itself never validates the sum, and this function
 * doesn't either; it only reports the gap the way `reconcilePurchase` reports
 * `statedTotal` vs. `expenseTotal`.
 */
describe("splitExpenseDelta", () => {
  it("is zero when the parts sum exactly to the original", () => {
    expect(splitExpenseDelta(100, [60, 40])).toEqual({
      originalCost: 100,
      partsSum: 100,
      delta: 0,
    });
  });

  it("reports a positive delta when parts overshoot and negative when they undershoot", () => {
    expect(splitExpenseDelta(100, [70, 40])).toEqual({
      originalCost: 100,
      partsSum: 110,
      delta: 10,
    });
    expect(splitExpenseDelta(100, [50, 30])).toEqual({
      originalCost: 100,
      partsSum: 80,
      delta: -20,
    });
  });

  it("is null only when there is no original cost to compare against", () => {
    expect(splitExpenseDelta(null, [50, 50])).toEqual({
      originalCost: null,
      partsSum: 100,
      delta: null,
    });
  });

  it("compares in cents, not floats", () => {
    // Math.abs(0.1 + 0.2 - 0.3) !== 0 in plain float arithmetic; a cents-based
    // comparison must still call this an exact match.
    const result = splitExpenseDelta(0.3, [0.1, 0.2]);
    expect(result.delta).toBe(0);
    expect(result.partsSum).toBe(0.3);

    // A genuine one-cent gap must still register, at a magnitude where a raw
    // float subtraction (`326.36 - 326.35`) misses it (`0.009999999999990905`).
    expect(splitExpenseDelta(326.36, [200, 126.35]).delta).toBeCloseTo(
      -0.01,
      10,
    );
  });
});
