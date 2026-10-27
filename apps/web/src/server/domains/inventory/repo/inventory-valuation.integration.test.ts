import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import {
  inventoryScaffold,
  readInventory,
} from "~/server/domains/inventory/repo/crud";
import { drainStoredDerived } from "~/server/testing/background-queue";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  listInventoryFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

const page = { pageIndex: 0, pageSize: 50 };
const each = (value: number) => ({ value, unit: "each" }) as const;

/**
 * `InventoryEntry.valuation` is a stored derived value (ADR 0021): the record
 * read and lists both use the published figure. A price
 * moved by ANY path (here a bare UPDATE, with no sync step to forget) marks
 * the entry through the generated trigger, so the drain republishes it.
 */
describe("inventory valuation — stored and recomputed on change", () => {
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

  it("retains the published value until a price change drains, without a write to the entry", async () => {
    const { sku, entry } = await seed("Valuation Widget", 10, 2);
    await drainStoredDerived(ctx.db);

    expect((await readInventory(ctx.db, entry.id))?.valuation).toBe(20);

    // Bypass every repo write path: only the product row changes.
    await getDb(ctx.db)
      .update(product)
      .set({ price: 30 })
      .where(eq(product.id, sku.entityId));

    expect((await readInventory(ctx.db, entry.id))?.valuation).toBe(20);
    // The price edit marked the entry; the drain republishes the record and list figure.
    await drainStoredDerived(ctx.db);
    expect((await readInventory(ctx.db, entry.id))?.valuation).toBe(60);
    const list = await listInventoryFixture(ctx.db, {}, [], page);
    expect(list.data.find((row) => row.id === entry.id)?.valuation).toBe(60);
    expect(
      (await inventoryScaffold.totals(ctx.db, {}))?.valuation,
    ).toBeGreaterThanOrEqual(60);
  });

  it("sorts, filters and totals on the computed figure", async () => {
    const [cheap, pricey, unpriced] = await Promise.all([
      seed("Sort Cheap", 5, 1),
      seed("Sort Pricey", 50, 1),
      seed("Sort Unpriced", undefined, 1),
    ]);
    await drainStoredDerived(ctx.db);
    const ids: string[] = [cheap, pricey, unpriced].map(
      ({ entry }) => entry.id,
    );
    const only = (rows: Array<{ id: string }>) =>
      rows.map((row) => row.id).filter((id) => ids.includes(id));

    const byValue = await listInventoryFixture(
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

    const valued = await listInventoryFixture(
      ctx.db,
      { valuationStatus: "valued" },
      [],
      page,
    );
    expect(only(valued.data).sort()).toEqual(
      [cheap.entry.id, pricey.entry.id].sort(),
    );
    const missing = await listInventoryFixture(
      ctx.db,
      { valuationStatus: ["priceable", "unpriceable"] },
      [],
      page,
    );
    expect(only(missing.data)).toEqual([unpriced.entry.id]);
    expect(
      (await inventoryScaffold.totals(ctx.db, { valuationStatus: "valued" }))
        ?.valuation,
    ).toBeGreaterThanOrEqual(55);
  });
});
