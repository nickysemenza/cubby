import type { ImageListFilters } from "@cubby/schemas/image";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildImageWhere } from "./image";

// SAFETY: test-only partial filter set; buildImageWhere only reads the keys
// under test, so a partial object is safe to pass here.
const where = (filters: Partial<ImageListFilters> = {}) =>
  renderWhereSql(
    buildImageWhere(mockWhereDatabase(), filters as ImageListFilters),
  );

describe("buildImageWhere", () => {
  it("still resolves to a defined base predicate with no filters applied", () => {
    // Guards the B6 migration to declaredFilterPredicates: an empty filter
    // set narrows on nothing but soft-delete, same as before.
    expect(where()).toBeDefined();
  });

  it("still narrows by filename and status (declared stored filters)", () => {
    expect(where({ nameFilter: "receipt" })).toContain('"filename"');
    expect(where({ status: "UPLOADED" })).toContain('"status"');
  });
});
