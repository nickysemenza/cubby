import type { VendorFilters } from "@cubby/schemas/vendor";
import { describe, expect, it } from "vitest";

import { renderWhereSql } from "~/server/repo/database-helpers/mock-db";

import { buildVendorWhereClause } from "./vendor";

const where = (filters: VendorFilters = {}) =>
  renderWhereSql(buildVendorWhereClause(filters));

describe("buildVendorWhereClause", () => {
  it("resolves to a defined base predicate with no filters applied", () => {
    expect(where()).toBeDefined();
  });

  it("matches name, notes, or website (declared stored text filter)", () => {
    const rendered = where({ search: "hardware" });
    expect(rendered).toContain('"name"');
    expect(rendered).toContain('"notes"');
    expect(rendered).toContain('"website"');
  });
});
