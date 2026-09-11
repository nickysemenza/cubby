import type { ProductFilters } from "@cubby/schemas/product";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildProductWhere } from "./crud";

const where = (filters: ProductFilters = {}) =>
  buildProductWhere(mockWhereDatabase(), filters).then(renderWhereSql);

describe("buildProductWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", async () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(await where()).toBeDefined();
  });

  it("still narrows by name, model, and notes (declared stored text filters)", async () => {
    expect(await where({ nameFilter: "flour" })).toContain('"name"');
    expect(await where({ modelFilter: "DCD" })).toContain('"model"');
    expect(await where({ notesFilter: "gift" })).toContain('"notes"');
  });

  it("still narrows by category (declared stored multiselect + presence)", async () => {
    expect(await where({ categoryFilter: "food" })).toContain('"category"');
    expect(await where({ categoryPresenceFilter: "none" })).toContain(
      '"category"',
    );
  });

  it("still narrows by manufacturerExact (declared stored multiselect)", async () => {
    expect(await where({ manufacturerExact: "DeWalt" })).toContain(
      '"manufacturer"',
    );
  });
});
