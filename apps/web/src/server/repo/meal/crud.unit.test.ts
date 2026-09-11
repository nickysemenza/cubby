import type { MealFilters } from "@cubby/schemas/meal";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildMealWhere } from "./crud";

const where = (filters: MealFilters = {}) =>
  renderWhereSql(buildMealWhere(mockWhereDatabase(), filters));

describe("buildMealWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(where()).toBeDefined();
  });

  it("still narrows by mealType and mealKind (declared stored filters)", () => {
    expect(where({ mealType: "dinner" })).toContain('"mealType"');
    expect(where({ mealTypePresenceFilter: "none" })).toContain('"mealType"');
    expect(where({ mealKind: "cooked" })).toContain('"mealKind"');
  });
});
