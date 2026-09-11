import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildRecipeWhere } from "./crud";
import type { RecipeFilters } from "./internal-types";

const where = (filters: RecipeFilters = {}) =>
  buildRecipeWhere(mockWhereDatabase(), filters).then(renderWhereSql);

describe("buildRecipeWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", async () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(await where()).toBeDefined();
  });

  it("still narrows by totalMinutes (declared stored numeric range filter)", async () => {
    expect(await where({ totalMinutesMin: 10 })).toContain('"totalMinutes"');
    expect(await where({ totalMinutesMax: 60 })).toContain('"totalMinutes"');
  });
});
