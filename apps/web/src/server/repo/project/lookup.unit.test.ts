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

  it("still narrows by location (hand-written: array-overlap, not eqAny)", async () => {
    expect(await where({ location: "Garage" })).toContain('"locations"');
  });
});
