import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { product } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  getInventoryEntryByShortcode,
  inventoryentryList,
} from "~/server/repo/inventory/crud";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

const page = { pageIndex: 0, pageSize: 50 };
const each = (value: number) => ({ value, unit: "each" }) as const;

/**
 * `InventoryEntry.valuation` is computed on every read from the amount, the
 * product's unit-mapping graph and its current price. Nothing stores it, so a
 * price moved by ANY path (here a bare UPDATE, with no sync step to forget) is
 * reflected on the next read — the stored column used to go stale until a
 * fan-out remembered to rewrite it.
 */
describe("inventory valuation — computed on read", () => {
  const ctx = withTestDb();

  const seed = async (
    name: string,
    price: number | undefined,
    quantity: number,
  ) => {
    const sku = await createProductFixture(
      ctx.db,
      makeProductInput({ name, price }),
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: `${name} shelf`, type: "shelf" }),
      ctx.actor,
    );
    const entry = await createInventoryFixture(
      ctx.db,
      { productId: sku.id, locationId: shelf.id, amount: each(quantity) },
      ctx.actor,
    );
    return { sku, entry };
  };

  it("reads amount × price, and follows a price change with no write to the entry", async () => {
    const { sku, entry } = await seed("Valuation Widget", 10, 2);

    expect(
      (await getInventoryEntryByShortcode(ctx.db, entry.id))?.valuation,
    ).toBe(20);

    // Bypass every repo write path: only the product row changes.
    await getDb(ctx.db)
      .update(product)
      .set({ price: 30 })
      .where(eq(product.id, sku.entityId));

    expect(
      (await getInventoryEntryByShortcode(ctx.db, entry.id))?.valuation,
    ).toBe(60);
    const list = await inventoryentryList(ctx.db, {}, [], page);
    expect(list.data.find((row) => row.id === entry.id)?.valuation).toBe(60);
    expect(list.sums!.valuation).toBeGreaterThanOrEqual(60);
  });

  it("sorts, filters and totals on the computed figure", async () => {
    const [cheap, pricey, unpriced] = await Promise.all([
      seed("Sort Cheap", 5, 1),
      seed("Sort Pricey", 50, 1),
      seed("Sort Unpriced", undefined, 1),
    ]);
    const ids: string[] = [cheap, pricey, unpriced].map(
      ({ entry }) => entry.id,
    );
    const only = (rows: Array<{ id: string }>) =>
      rows.map((row) => row.id).filter((id) => ids.includes(id));

    const byValue = await inventoryentryList(
      ctx.db,
      {},
      [{ orderBy: "valuation", direction: "desc" }],
      page,
    );
    expect(only(byValue.data)).toEqual([
      pricey.entry.id,
      cheap.entry.id,
      unpriced.entry.id,
    ]);

    const valued = await inventoryentryList(
      ctx.db,
      { valuationStatus: "valued" },
      [],
      page,
    );
    expect(only(valued.data).sort()).toEqual(
      [cheap.entry.id, pricey.entry.id].sort(),
    );
    const missing = await inventoryentryList(
      ctx.db,
      { valuationStatus: "missing" },
      [],
      page,
    );
    expect(only(missing.data)).toEqual([unpriced.entry.id]);
    expect(valued.sums!.valuation).toBeGreaterThanOrEqual(55);
  });
});
