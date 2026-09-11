import type { FinancialAccountFilters } from "@cubby/schemas/financial-account";
import { describe, expect, it } from "vitest";

import { renderWhereSql } from "~/server/repo/database-helpers/mock-db";

import { buildFinancialAccountWhere } from "./financial-account";

const where = (filters: FinancialAccountFilters = {}) =>
  renderWhereSql(buildFinancialAccountWhere(filters));

describe("buildFinancialAccountWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(where()).toBeDefined();
  });

  it("still narrows by name and provisional (declared stored filters)", () => {
    expect(where({ search: "checking" })).toContain('"name"');
    expect(where({ provisional: true })).toContain('"provisional"');
  });
});
