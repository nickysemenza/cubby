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

describe("buildMealWhere recipeCostCoverage=understated", () => {
  it("matches partial costs and unavailable costs that recorded contributors", () => {
    const rendered = where({ recipeCostCoverage: "understated" });
    expect(rendered).toContain("'partial'");
    expect(rendered).toContain("'unavailable'");
    expect(rendered).toContain("{cost,coverage,total}");
    // The subselect joins two tables, so the JSON column must stay qualified.
    expect(rendered).toMatch(
      /"Recipe"\."totals" #>> '\{cost,coverage,total\}'/,
    );
  });
});
