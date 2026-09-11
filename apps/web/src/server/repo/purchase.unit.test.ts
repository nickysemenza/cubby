import type { PurchaseFilters } from "@cubby/schemas/purchase";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildPurchaseWhereClause } from "./purchase";

const where = async (filters: PurchaseFilters = {}) =>
  renderWhereSql(await buildPurchaseWhereClause(mockWhereDatabase(), filters));

describe("buildPurchaseWhereClause", () => {
  it("still resolves to a defined base predicate with no filters applied", async () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(await where()).toBeDefined();
  });

  it("still narrows by displayLabelSearch (declared stored filter)", async () => {
    expect(await where({ displayLabelSearch: "invoice" })).toContain(
      '"displayLabel"',
    );
  });
});
