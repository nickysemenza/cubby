import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db/database";

import { recomputeRecipesForPriceAffectedProducts } from "./expense-pricing.service";
import type { RecipeCostingService } from "./recipe-costing.service";

/**
 * The empty-id path returns before `db` is dereferenced — `uniq(productIds)`
 * then `if (ids.length === 0) return []`, so `loadIngredientIdsForProducts`
 * never runs. This was an integration test sharing a `withTestDb()` with a
 * sibling that genuinely needs Postgres; asserting against a `db` Proxy that
 * throws on any property access states the early return more directly than a
 * live connection could.
 */
const explodingDb = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(
        `expense-pricing touched the database (property "${String(prop)}") on the empty-id path`,
      );
    },
  },
) as Database;

describe("recomputeRecipesForPriceAffectedProducts", () => {
  it("skips the service, and the database, when no product price changed", async () => {
    const recomputeForIngredients = vi.fn();
    const service = {
      recomputeForIngredients,
    } as unknown as RecipeCostingService;

    await expect(
      recomputeRecipesForPriceAffectedProducts(
        explodingDb,
        service,
        [],
        "expense.test",
      ),
    ).resolves.toEqual([]);
    expect(recomputeForIngredients).not.toHaveBeenCalled();
  });
});
