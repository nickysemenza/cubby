import {
  smartCollectionDetailOut,
  type SmartCollectionDefinition,
} from "@cubby/schemas/collection";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expense, inventoryEntry, location, product } from "~/server/db/schema";

import { getSmartCollectionDetail, listSmartCollections } from "./collection";
import { getDb } from "./database-helpers";
import { createExpense } from "./expense";
import { updateLocation } from "./location";
import { attachPurchaseProducts } from "./purchase-products";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";
import { findOrCreateVendor } from "./vendor";

describe("smart Collection live relationships", () => {
  const ctx = withTestDb();
  const painting: SmartCollectionDefinition = {
    key: "painting",
    name: "Paint",
    rules: [{ kind: "locationNameContains", value: "paint" }],
  };
  const detail = (definition = painting, pageIndex = 0, pageSize = 100) =>
    getSmartCollectionDetail(ctx.db, definition, undefined, {
      pageIndex,
      pageSize,
    });

  it("reflects new roots, renames, reparenting, movement and deleted placements without persisting membership", async () => {
    const root = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Supplies" }),
      ctx.actor,
    );
    const bin = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Small bin", parentId: root.id }),
      ctx.actor,
    );
    const other = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Other shelf" }),
      ctx.actor,
    );
    const brush = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic brush", tags: ["fits-example"] }),
      ctx.actor,
    );
    const entry = await createInventoryFixture(
      ctx.db,
      {
        productId: brush.id,
        locationId: bin.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    expect((await detail()).totalCount).toBe(0);
    await updateLocation(
      ctx.db,
      root.entityId,
      { name: "PAINT supplies" },
      ctx.actor,
    );
    expect((await detail()).products.map((item) => item.id)).toEqual([
      brush.id,
    ]);
    await updateLocation(
      ctx.db,
      bin.entityId,
      { parentId: other.id },
      ctx.actor,
    );
    expect((await detail()).totalCount).toBe(0);
    const newRoot = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Spray painting" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ locationId: newRoot.entityId })
      .where(eq(inventoryEntry.id, entry.entityId));
    expect((await detail()).totalCount).toBe(1);
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ deletedAt: new Date() })
      .where(eq(inventoryEntry.id, entry.entityId));
    expect((await detail()).totalCount).toBe(0);
    const unchanged = await getDb(ctx.db).query.product.findFirst({
      where: eq(product.id, brush.entityId),
      columns: { tags: true },
    });
    expect(unchanged?.tags).toEqual(["fits-example"]);
  });

  it("excludes self-placement and deleted rows while deduplicating overlapping roots before pagination", async () => {
    const vessel = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic vessel" }),
      ctx.actor,
    );
    const root = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Paint bench" }),
      ctx.actor,
    );
    const bin = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Painting bin",
        parentId: root.id,
        productId: vessel.id,
        type: null,
      }),
      ctx.actor,
    );
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "A brush" }),
      ctx.actor,
    );
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "B brush" }),
      ctx.actor,
    );
    for (const item of [first, second])
      await createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: bin.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    await createInventoryFixture(
      ctx.db,
      {
        productId: first.id,
        locationId: root.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    // Deliberately malformed legacy evidence: the read must not report a vessel inside itself.
    await insertWithShortcode(ctx.db, "inventory", {
      productId: vessel.entityId,
      locationId: bin.entityId,
      amount: { value: 1, unit: "each" },
    });
    const page = await detail(painting, 0, 1);
    expect(smartCollectionDetailOut.safeParse(page).success).toBe(true);
    expect(page.totalCount).toBe(2);
    expect(page.summary.sourceCounts.locationNameContains).toBe(2);
    expect(page.products.map((item) => item.id)).toEqual([first.id]);
    expect(
      (await detail(painting, 1, 1)).products.map((item) => item.id),
    ).toEqual([second.id]);
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, second.entityId));
    expect((await detail()).totalCount).toBe(1);
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, bin.entityId));
    expect((await detail()).products.map((item) => item.id)).toEqual([
      first.id,
    ]);
  });

  it("uses each Product's own actual Expense trade, never other purchase lines, and deduplicates purchase context", async () => {
    const first = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Trade brush", tags: ["collection:painting"] }),
      ctx.actor,
    );
    const second = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Electrical accessory" }),
      ctx.actor,
    );
    const vendorId = await findOrCreateVendor(ctx.db, "Synthetic supplier");
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-01-01",
    });
    const purchaseId = parseShortcodeFor("purchase", order.shortcode);
    const line = await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          productId: first.id,
          purchaseId,
          trade: "finishes",
        }),
      ),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          productId: second.id,
          purchaseId,
          trade: "electrical",
        }),
      ),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          productId: second.id,
          trade: "finishes",
          future: true,
        }),
      ),
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      order.id,
      [first.entityId, second.entityId],
      ctx.actor,
    );
    const rule: SmartCollectionDefinition = {
      ...painting,
      rules: [{ kind: "historicalExpenseTrade", value: "finishes" }],
    };
    const result = await detail(rule);
    expect(result.products.map((item) => item.id)).toEqual([first.id]);
    expect(result.products[0]?.purchases).toHaveLength(1);
    expect(result.products[0]?.purchases[0]?.trades).toEqual([
      "electrical",
      "finishes",
    ]);
    expect(result.products[0]?.matches?.[0]?.evidence[0]).toContain(
      line.output.id,
    );
    const combined = {
      ...rule,
      rules: [
        ...rule.rules,
        {
          kind: "productTagEquals",
          value: "collection:painting",
        } satisfies SmartCollectionDefinition["rules"][number],
      ],
    };
    expect((await listSmartCollections(ctx.db, [combined]))[0]).toMatchObject({
      totalCount: 1,
      sourceCounts: { productTagEquals: 1, historicalExpenseTrade: 1 },
    });
    await getDb(ctx.db)
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(eq(expense.id, line.entityId));
    expect((await detail(rule)).totalCount).toBe(0);
    expect((await detail(combined)).totalCount).toBe(1);
  });
});
