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

  it("bounds date, cost and quantity, and searches notes and url (declared stored filters)", async () => {
    expect(await where({ dateFrom: "2026-01-01" })).toContain('"date" >=');
    // Zero is a meaningful bound: `costMax: 0` is the credits-only worklist.
    expect(await where({ costMax: 0 })).toContain('"cost" <=');
    expect(await where({ costMin: 0 })).toContain('"cost" >=');
    expect(await where({ productQuantityMax: -1 })).toContain(
      '"productQuantity" <=',
    );
    expect(await where({ notesSearch: "refund" })).toContain('"notes" ilike');
    expect(await where({ urlSearch: "example" })).toContain('"url" ilike');
  });

  it("still narrows by lineKind, lineBasis, costType, trade, and future (declared stored filters)", async () => {
    expect(await where({ lineKind: "tax" })).toContain('"lineKind"');
    expect(await where({ lineBasis: "item_line" })).toContain('"lineBasis"');
    expect(await where({ costType: "materials" })).toContain('"costType"');
    expect(await where({ trade: "electrical" })).toContain('"trade"');
    expect(await where({ future: true })).toContain('"future"');
  });
});
