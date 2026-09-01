/**
 * Whole-tree valuation recompute, against real SQL.
 *
 * The rollup arithmetic is already pinned by location-valuation-rollup.unit.test.ts
 * over in-memory fixtures, so what is left to get wrong is the read that feeds
 * it — and it can only be wrong in ways Postgres alone exhibits. The price of
 * the SKU a location IS was assembled from a raw SQL fragment that has to be
 * handed the enclosing query's exact table alias; a mismatch is a runtime
 * `missing FROM-clause entry for table "product"` (42P01), invisible to
 * typecheck and to every tier below this one. It shipped that way and every
 * `Location.valuation` in production went stale until it was noticed.
 *
 * So these tests call `recompute()` end-to-end over a tree that contains a
 * product-linked location, and read the persisted column back.
 */

import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createExpense } from "~/server/repo/expense";
import { getLocationById } from "~/server/repo/location";
import {
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { LocationValuationService } from "./location-valuation.service";

describe("LocationValuationService.recompute", () => {
  const ctx = withTestDb();

  const seedProduct = (name: string, price: number | null) =>
    createProductFixture(
      ctx.db,
      price === null
        ? makeProductInput({ name })
        : makeProductInput({ name, price }),
      TEST_ACTOR,
    );

  it("prices a vessel with no explicit price from its Expense history", async () => {
    const crateSku = await seedProduct("Wooden Crate", null);
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Crate two-pack",
        productId: crateSku.id,
        productQuantity: 2,
        cost: 50,
      }),
      TEST_ACTOR,
    );

    const room = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Cellar", type: "room" }),
      TEST_ACTOR,
    );
    await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Crate A",
        type: null,
        productId: crateSku.id,
        parentId: room.id,
      }),
      TEST_ACTOR,
    );

    await new LocationValuationService(ctx.db).recompute();

    // $50 over 2 units = $25 each, the derived price — the branch that carried
    // the correlated sub-select the alias bug lived in.
    const storedRoom = await getLocationById(ctx.db, room.entityId);
    expect(storedRoom.valuation).toMatchObject({
      container: { directValuation: 25, directItemCount: 1 },
    });
  });
});
