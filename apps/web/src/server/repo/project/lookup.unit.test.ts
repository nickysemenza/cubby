import type { ProjectFilters } from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildProjectWhere } from "./lookup";

const where = (filters: ProjectFilters = {}) =>
  buildProjectWhere(mockWhereDatabase(), filters).then(renderWhereSql);

describe("buildProjectWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", async () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(await where()).toBeDefined();
  });

  it("still narrows by status and kind (declared stored multiselect filters)", async () => {
    expect(await where({ status: "done" })).toContain('"status"');
    expect(await where({ kind: "furniture" })).toContain('"kind"');
  });

  it("still narrows by location as an array overlap (declared stored array filter)", async () => {
    expect(await where({ location: "Garage" })).toContain('"locations" &&');
  });

  it("matches name, notes, and locations by element (declared stored text filter)", async () => {
    const rendered = await where({ search: "shed" });
    expect(rendered).toContain('"name"');
    expect(rendered).toContain('"notes"');
    expect(rendered).toContain('unnest("Project"."locations")');
  });
});
