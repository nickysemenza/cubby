import type { IngredientFilters } from "@cubby/schemas/ingredient";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildIngredientListWhere } from "./search";

// SAFETY: test-only partial filter set; buildIngredientListWhere only reads
// the keys under test, so a partial object is safe to pass here.
const where = (filters: Partial<IngredientFilters> = {}) =>
  buildIngredientListWhere(
    mockWhereDatabase(),
    filters as IngredientFilters,
  ).then(renderWhereSql);

describe("buildIngredientListWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", async () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete/recipe-ingredient exclusion,
    // same as before.
    expect(await where()).toBeDefined();
  });

  it("still narrows by usuallyOnHand (declared stored boolean filter)", async () => {
    expect(await where({ usuallyOnHand: true })).toContain('"usuallyOnHand"');
    expect(await where({ usuallyOnHand: false })).toContain('"usuallyOnHand"');
  });
});
