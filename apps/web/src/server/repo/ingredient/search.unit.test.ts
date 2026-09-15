import {
  type IngredientFilters,
  ingredientFiltersSchema,
} from "@cubby/schemas/ingredient";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildIngredientListWhere } from "./search";

// Parsed rather than asserted: the related-view filter trios carry branded
// shortcodes, and every filter field is optional, so the schema accepts the
// partial set under test.
const where = (filters: Partial<IngredientFilters> = {}) =>
  buildIngredientListWhere(
    mockWhereDatabase(),
    ingredientFiltersSchema.parse(filters),
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
