import { expect } from "vitest";

import { withDatabaseOperationMetrics } from "~/server/db/db-observability";

export type StatementBudget = {
  /** Upper bound on statements, including transaction control. */
  statements: number;
  /** Upper bound on bound parameters in any one statement. */
  parameters: number;
};

/**
 * Run a journey step and fail when its database work outgrows the budget.
 * Per-row reads raise `statements`; request-sized bind lists raise
 * `parameters`. Both should stay flat as the request grows.
 */
export const expectStatementBudget = async <T>(
  fn: () => Promise<T>,
  budget: StatementBudget,
): Promise<T> =>
  withDatabaseOperationMetrics(async (metrics) => {
    const result = await fn();
    expect(metrics.queryCount, "statements").toBeLessThanOrEqual(
      budget.statements,
    );
    expect(
      metrics.queryMaxParameterCount,
      "parameters in one statement",
    ).toBeLessThanOrEqual(budget.parameters);
    return result;
  });
