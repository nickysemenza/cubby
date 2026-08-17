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

import { TEST_ACTOR, TEST_HOME_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createExpense } from "~/server/repo/expense";
import { getLocationById } from "~/server/repo/location";
import {
  createInventoryFixture,
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
      makeProductInput({ name, ...(price === null ? {} : { price }) }),
      TEST_ACTOR,
    );

  it("values a tree whose shelf is itself a product", async () => {
    const widget = await seedProduct("Widget", 10);
    const binSku = await seedProduct("Storage Bin", 40);

    const room = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Garage", type: "room" }),
      TEST_ACTOR,
    );
    // The vessel: a location that IS a SKU. Its own price is the thing the
    // broken alias made unreadable.
    const bin = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Bin 1",
        type: null,
        productId: binSku.id,
        parentId: room.id,
      }),
      TEST_ACTOR,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: widget.id,
        locationId: bin.id,
        amount: { value: 2, unit: "each" },
      },
      TEST_ACTOR,
    );

    const written = await new LocationValuationService(ctx.db).recompute();
    expect(written).toBe(3);

    const storedBin = await getLocationById(ctx.db, bin.entityId);
    expect(storedBin.valuation).toMatchObject({
      directValuation: 20,
      totalValuation: 20,
      // One entry of two units — itemCount counts placements, not units.
      directItemCount: 1,
      // The bin's own $40 belongs to the room that holds it, not to itself.
      container: { directValuation: 0, totalValuation: 0, directItemCount: 0 },
    });

    const storedRoom = await getLocationById(ctx.db, room.entityId);
    expect(storedRoom.valuation).toMatchObject({
      directValuation: 0,
      totalValuation: 20,
      totalItemCount: 1,
      container: {
        directValuation: 40,
        totalValuation: 40,
        directItemCount: 1,
        totalItemCount: 1,
      },
    });

    const storedHome = await getLocationById(ctx.db, TEST_HOME_ID);
    expect(storedHome.valuation).toMatchObject({
      directValuation: 0,
      totalValuation: 20,
      directItemCount: 0,
      totalItemCount: 1,
      container: {
        directValuation: 0,
        totalValuation: 40,
        directItemCount: 0,
        totalItemCount: 1,
      },
    });
  });

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

  it("leaves a productless tree's container bucket empty", async () => {
    const room = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Pantry", type: "room" }),
      TEST_ACTOR,
    );
    await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Pantry shelf",
        type: "shelf",
        parentId: room.id,
      }),
      TEST_ACTOR,
    );

    await new LocationValuationService(ctx.db).recompute();

    const storedRoom = await getLocationById(ctx.db, room.entityId);
    expect(storedRoom.valuation).toMatchObject({
      totalValuation: 0,
      container: { directValuation: 0, totalValuation: 0, totalItemCount: 0 },
    });
  });
});
