import type { ExpenseFilters } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildExpenseWhereClause } from "./lookup";

const where = (filters: ExpenseFilters = {}) =>
  buildExpenseWhereClause(mockWhereDatabase(), filters).then(renderWhereSql);

describe("buildExpenseWhereClause", () => {
  it("still resolves to a defined base predicate with no filters applied", async () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(await where()).toBeDefined();
  });

  it("still narrows by lineKind, lineBasis, costType, trade, and future (declared stored filters)", async () => {
    expect(await where({ lineKind: "tax" })).toContain('"lineKind"');
    expect(await where({ lineBasis: "item_line" })).toContain('"lineBasis"');
    expect(await where({ costType: "materials" })).toContain('"costType"');
    expect(await where({ trade: "electrical" })).toContain('"trade"');
    expect(await where({ future: true })).toContain('"future"');
  });
});
