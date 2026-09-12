import type { WishFilters } from "@cubby/schemas/wish";
import { describe, expect, it } from "vitest";

import {
  mockWhereDatabase,
  renderWhereSql,
} from "~/server/repo/database-helpers/mock-db";

import { buildWishWhere } from "./wish";

const where = (filters: WishFilters = {}) =>
  buildWishWhere(mockWhereDatabase(), filters).then(renderWhereSql);

describe("buildWishWhere", () => {
  it("resolves to a defined base predicate with no filters applied", async () => {
    expect(await where()).toBeDefined();
  });

  it("reads acquired as presence of acquiredAt (declared stored boolean)", async () => {
    expect(await where({ acquired: true })).toContain(
      '"acquiredAt" is not null',
    );
    expect(await where({ acquired: false })).toContain('"acquiredAt" is null');
  });
});
