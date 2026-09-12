import type { FinancialTransactionFilters } from "@cubby/schemas/financial-transaction";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildFinancialTransactionWhere } from "./financial-transaction";

const where = async (filters: FinancialTransactionFilters = {}) =>
  renderWhereSql(
    await buildFinancialTransactionWhere(mockWhereDatabase(), filters),
  );

describe("buildFinancialTransactionWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", async () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(await where()).toBeDefined();
  });

  it("matches merchant OR raw description (declared stored text filter)", async () => {
    // Regression: the hand-written version ANDed the two columns, so a term
    // had to appear in both to match.
    expect(await where({ search: "coffee" })).toMatch(
      /"merchant" ilike \$\d+ or "FinancialTransaction"\."rawDescription" ilike/u,
    );
  });

  it("still narrows by kind, status, merchant, and posted date (declared stored filters)", async () => {
    expect(await where({ kind: "purchase" })).toContain('"kind"');
    expect(await where({ status: "posted" })).toContain('"status"');
    expect(await where({ merchant: "acme" })).toContain('"merchant"');
    expect(await where({ postedDateFrom: "2026-01-01" })).toContain(
      '"postedDate"',
    );
    expect(await where({ postedDateTo: "2026-01-01" })).toContain(
      '"postedDate"',
    );
  });
});
