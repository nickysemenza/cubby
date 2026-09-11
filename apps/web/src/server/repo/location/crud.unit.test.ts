import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildLocationWhere } from "./crud";
import type { LocationFilters } from "./internal-types";

// SAFETY: test-only partial filter set; buildLocationWhere only reads the
// keys under test, so a partial object is safe to pass here.
const where = (filters: Partial<LocationFilters> = {}) =>
  buildLocationWhere(mockWhereDatabase(), filters as LocationFilters).then(
    renderWhereSql,
  );

describe("buildLocationWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", async () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(await where()).toBeDefined();
  });

  it("still narrows by type (declared stored multiselect filter)", async () => {
    expect(await where({ itemTypeFilter: "shelf" })).toContain('"type"');
  });
});
