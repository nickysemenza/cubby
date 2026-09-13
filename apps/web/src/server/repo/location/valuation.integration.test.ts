/**
 * Location valuation — computed on read, against real SQL.
 *
 * The rollup arithmetic is already pinned by
 * `location-valuation-rollup.unit.test.ts` over in-memory fixtures, so what is
 * left to get wrong is the read that feeds it — and it can only be wrong in
 * ways Postgres alone exhibits. The price of the SKU a location IS was once
 * assembled from a raw SQL fragment that had to be handed the enclosing
 * query's exact table alias; a mismatch is a runtime `missing FROM-clause
 * entry for table "product"` (42P01), invisible to typecheck and to every
 * tier below this one. It shipped that way and every location valuation in
 * production went stale until it was noticed.
 *
 * So these tests call `computeLocationValuations` end-to-end over a tree that
 * contains a product-linked location, check `directValuationSql` (the list
 * filter/sort's SQL twin of the same figure) agrees with it, and check the
 * Home summary.
 */

import { withTestDb } from "tooling/test-setup";
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
import { rollupLocationValuations } from "~/server/services/location-valuation-rollup";

import { locationList } from "./crud";
import {
  computeLocationValuations,
  getLocationValuationSummary,
  loadLocationValuationInputs,
} from "./valuation";

const page = { pageIndex: 0, pageSize: 50 };

describe("location valuation — computed on read", () => {
  const ctx = withTestDb();

  it("computeLocationValuations matches the pure rollup, and getLocationById threads the same map", async () => {
    const crateSku = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Wooden Crate" }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Crate two-pack",
        productId: crateSku.id,
        productQuantity: 2,
        cost: 50,
      }),
      ctx.actor,
    );

    const room = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Cellar", type: "room" }),
      ctx.actor,
    );
    await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Crate A",
        type: null,
        productId: crateSku.id,
        parentId: room.id,
      }),
      ctx.actor,
    );

    const valuations = await computeLocationValuations(ctx.db);
    const { entries, locations } = await loadLocationValuationInputs(ctx.db);
    expect(valuations).toEqual(rollupLocationValuations(entries, locations));

    // $50 over 2 units = $25 each, the derived price — the branch that
    // carried the correlated sub-select the historical alias bug lived in.
    expect(valuations.get(room.entityId)).toMatchObject({
      container: { directValuation: 25, directItemCount: 1 },
    });

    const storedRoom = await getLocationById(ctx.db, room.entityId);
    expect(storedRoom.valuation).toMatchObject({
      container: { directValuation: 25, directItemCount: 1 },
    });
  });

  it("agrees with the list filter/sort's directValuationSql, and the Home summary", async () => {
    const [cheap, pricey] = await Promise.all([
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Cheap Widget", price: 10 }),
        ctx.actor,
      ),
      createProductFixture(
        ctx.db,
        makeProductInput({ name: "Pricey Widget", price: 40 }),
        ctx.actor,
      ),
    ]);
    const [lowShelf, highShelf] = await Promise.all([
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Low Shelf", type: "shelf" }),
        ctx.actor,
      ),
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "High Shelf", type: "shelf" }),
        ctx.actor,
      ),
    ]);
    const each = { value: 1, unit: "each" } as const;
    await createInventoryFixture(
      ctx.db,
      { productId: cheap.id, locationId: lowShelf.id, amount: each },
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      { productId: pricey.id, locationId: highShelf.id, amount: each },
      ctx.actor,
    );
    // An installed fixture must not count toward direct valuation, in either
    // the pure rollup or the SQL twin.
    await createInventoryFixture(
      ctx.db,
      {
        productId: pricey.id,
        locationId: lowShelf.id,
        amount: each,
        placement: "installed",
      },
      ctx.actor,
    );

    const valuations = await computeLocationValuations(ctx.db);
    const lowValuation = valuations.get(lowShelf.entityId)?.directValuation;
    const highValuation = valuations.get(highShelf.entityId)?.directValuation;
    expect(lowValuation).toBe(10);
    expect(highValuation).toBe(40);

    // Filter: only the shelf whose rollup direct value clears the bar.
    const filtered = await locationList(ctx.db, { valuationMin: 40 }, [], page);
    const filteredIds = filtered.data.map((l) => l.id);
    expect(filteredIds).toContain(highShelf.id);
    expect(filteredIds).not.toContain(lowShelf.id);

    // Sort: descending valuation puts the pricier shelf first.
    const sorted = await locationList(
      ctx.db,
      {},
      [{ orderBy: "valuation", direction: "desc" }],
      page,
    );
    const orderedShelfIds = sorted.data
      .map((l) => l.id)
      .filter((id) => id === lowShelf.id || id === highShelf.id);
    expect(orderedShelfIds).toEqual([highShelf.id, lowShelf.id]);

    // Home summary: top locations by direct value, and the grand total.
    const summary = await getLocationValuationSummary(ctx.db);
    const summaryById = new Map(summary.locations.map((l) => [l.id, l.value]));
    expect(summaryById.get(highShelf.id)).toBe(40);
    expect(summaryById.get(lowShelf.id)).toBe(10);
    expect(summary.total).toBeGreaterThanOrEqual(50);
  });
});
