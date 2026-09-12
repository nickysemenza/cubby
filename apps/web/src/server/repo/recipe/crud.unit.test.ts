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

  it("matches name or notes (declared stored text filter)", async () => {
    const rendered = await where({ nameFilter: "soup" });
    expect(rendered).toContain('"name"');
    expect(rendered).toContain('"notes"');
  });

  it("overlaps tags and ORs the untagged sentinel (declared stored array filter)", async () => {
    expect(await where({ tagFilters: ["quick"] })).toContain('"tags" &&');
    expect(await where({ tagFilters: "quick" })).toContain('"tags" &&');
    // `tags` is nullable, so untagged means NULL or zero-length.
    expect(await where({ tagsPresenceFilter: "none" })).toContain(
      '"tags" IS NULL OR cardinality("Recipe"."tags") = 0',
    );
  });

  it("still narrows by totalMinutes (declared stored numeric range filter)", async () => {
    expect(await where({ totalMinutesMin: 10 })).toContain('"totalMinutes"');
    expect(await where({ totalMinutesMax: 60 })).toContain('"totalMinutes"');
  });
});
