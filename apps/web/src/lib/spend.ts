// Pure spend-decomposition helpers, shared by the project detail page and the
// projects dashboard. Kept alias-free and React-free so it runs under the
// `*.unit.test.ts` vitest project (see vitest.config.ts).
//
// The core problem this solves: a naive `sumBy(expenses, (p) => p.cost)` blends
// three economically distinct quantities into one "spent" number —
//   - actual: money already out the door (cost > 0, not future-flagged)
//   - committed: planned/future expenses (cost > 0, future-flagged)
//   - contributions: legacy wire name for negative Expense credits that offset
//     spend; unrelated to household funding contributions
// `net` deliberately equals that old blended figure (== `rollup.spent`) so nothing
// downstream regresses; the split fields are purely additive.

// Structural input — anything with a nullable cost and a future flag. Accepting a
// minimal shape (rather than ExpenseOut) keeps this trivially testable.
export interface SpendableExpense {
  cost: number | null;
  future: boolean;
}

export interface SpendSplit {
  /** cost > 0 && !future — money already spent. */
  actual: number;
  /** cost > 0 && future — planned/committed, not yet spent. */
  committed: number;
  /** Σ|cost| where cost < 0 — credits (legacy field name), positive magnitude. */
  contributions: number;
  /** Σ cost across all rows === actual + committed − contributions === rollup.spent. */
  net: number;
}

export function splitExpenseSpend(expenses: SpendableExpense[]): SpendSplit {
  let actual = 0;
  let committed = 0;
  let contributions = 0;
  for (const { cost, future } of expenses) {
    if (cost == null || cost === 0) continue;
    if (cost < 0) {
      contributions += -cost;
    } else if (future) {
      committed += cost;
    } else {
      actual += cost;
    }
  }
  return {
    actual,
    committed,
    contributions,
    net: actual + committed - contributions,
  };
}

/**
 * Estimate minus net spend. Null when there is no estimate to measure against
 * (so callers can render a dash rather than a misleading "$X remaining").
 */
export function budgetRemaining(
  estimate: number | null,
  split: SpendSplit,
): number | null {
  if (estimate == null) return null;
  return estimate - split.net;
}
