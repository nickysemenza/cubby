import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  entityLink,
  expense,
  inventoryEntry,
  product,
  purchase,
} from "~/server/db/schema";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { mergeProducts } from "~/server/domains/product/repo/merge";
import { getProductMovementTimeline } from "~/server/domains/product/repo/movement-timeline";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  linkValues,
  liveLinks,
} from "~/server/generic/entity-links/repo/entity-links";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  attachPurchaseProducts,
  confirmPurchaseAcquisition,
  listProductPurchases,
  listPurchaseProducts,
} from "./purchase-products";

// Failure modes: legacy identity links masquerade as acquisition; confirmation
// invents money, stock, quantity or delivery; a caller rollback leaks a confirmed
// link; deleted endpoints are accepted; merging duplicate links erases confirmation.
// These repository/SQL contracts have no connection action or browser surface here.
describe("explicit purchase acquisition", () => {
  const ctx = withTestDb();
  const seed = async () => {
    const vendorId = await findOrCreateVendor(
      ctx.db,
      "Acquisition Test Vendor",
    );
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-02-01",
      displayLabel: "Acquisition test order",
    });
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Acquisition test tool" }),
      ctx.actor,
    );
    return { order, item };
  };
  const timeline = (id: string) =>
    getProductMovementTimeline(ctx.db, {
      filters: {},
      ids: [id],
      order: "desc",
      pagination: { pageIndex: 0, pageSize: 20 },
    });

  it("keeps legacy links Linked and confirms unknown acquisition without spending or stock", async () => {
    const { order, item } = await seed();
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Acquisition test shelf" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
        placement: "stock",
      },
      ctx.actor,
    );
    await attachPurchaseProducts(ctx.db, order.id, [item.entityId], ctx.actor);
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Acquisition planned",
        purchaseId: order.shortcode,
        productId: item.id,
        cost: 20,
        productQuantity: 1,
        future: true,
      }),
      ctx.actor,
    );
    const gaps = async () =>
      (await loadDataQualities(ctx.db, "product", [item.entityId]))
        .get(item.entityId)
        ?.gaps.map((gap) => gap.check);
    const before = await timeline(item.id);
    expect(before.groups[0]?.movements).toMatchObject([
      { kind: "linked", cost: null, quantity: null },
    ]);
    expect(await gaps()).toContain("product_unpurchased");
    const stockBefore = await getDb(ctx.db)
      .select()
      .from(inventoryEntry)
      .where(eq(inventoryEntry.productId, item.entityId));
    const ledgerBefore = await getDb(ctx.db).select().from(expense);
    expect(
      await confirmPurchaseAcquisition(ctx.db, {
        purchaseId: order.shortcode,
        productId: item.id,
      }),
    ).toEqual({ changed: true });
    expect(
      await confirmPurchaseAcquisition(ctx.db, {
        purchaseId: order.shortcode,
        productId: item.id,
      }),
    ).toEqual({ changed: false });
    const after = await timeline(item.id);
    expect(after.groups[0]?.movements).toMatchObject([
      {
        kind: "acquired",
        cost: null,
        quantity: null,
        signedQuantity: null,
        expenseId: null,
        expenseDate: null,
      },
    ]);
    expect(after.products[0]).toMatchObject({
      ownershipIntervals: [],
      confidenceLostAt: null,
    });
    expect(after.summary).toMatchObject({
      spent: 0,
      recovered: 0,
      netCost: 0,
      unknownAmountCount: 1,
    });
    expect(await gaps()).not.toContain("product_unpurchased");
    expect(await listPurchaseProducts(ctx.db, order.id)).toMatchObject([
      { movementKinds: ["acquired"] },
    ]);
    expect(await listProductPurchases(ctx.db, item.entityId)).toMatchObject([
      { movementKinds: ["acquired"] },
    ]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual(ledgerBefore);
    expect(
      await getDb(ctx.db)
        .select()
        .from(inventoryEntry)
        .where(eq(inventoryEntry.productId, item.entityId)),
    ).toEqual(stockBefore);
    await getDb(ctx.db)
      .update(purchase)
      .set({ deletedAt: new Date() })
      .where(eq(purchase.id, order.id));
    expect(await gaps()).toContain("product_unpurchased");
    await expect(
      confirmPurchaseAcquisition(ctx.db, {
        purchaseId: order.shortcode,
        productId: item.id,
      }),
    ).rejects.toMatchObject({ reason: "PURCHASE_NOT_FOUND" });
  });

  it("joins the caller transaction and refuses deleted endpoints", async () => {
    const { order, item } = await seed();
    await expect(
      withTransactionDatabase(ctx.db, async (db) => {
        await confirmPurchaseAcquisition(db, {
          purchaseId: order.shortcode,
          productId: item.id,
        });
        throw new Error("rollback acquisition");
      }),
    ).rejects.toThrow("rollback acquisition");
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityLink)
        .where(
          and(
            liveLinks("purchaseProduct"),
            eq(entityLink.fromEntityId, order.id),
          ),
        ),
    ).toEqual([]);
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, item.entityId));
    await expect(
      confirmPurchaseAcquisition(ctx.db, {
        purchaseId: order.shortcode,
        productId: item.id,
      }),
    ).rejects.toMatchObject({ reason: "PRODUCT_NOT_FOUND" });
  });

  it("retains confirmation when duplicate purchase links collide in a product merge", async () => {
    const { order, item } = await seed();
    const keeper = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Acquisition survivor" }),
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      order.id,
      [keeper.entityId],
      ctx.actor,
    );
    await confirmPurchaseAcquisition(ctx.db, {
      purchaseId: order.shortcode,
      productId: item.id,
    });
    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [item.id] },
      ctx.actor,
    );
    expect((await timeline(keeper.id)).groups[0]?.movements).toMatchObject([
      { kind: "acquired" },
    ]);
  });

  it("preserves separately confirmed acquisition beside an exit Expense", async () => {
    const { order, item } = await seed();
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Acquisition later sale",
        purchaseId: order.shortcode,
        productId: item.id,
        cost: -12,
        productQuantity: -1,
      }),
      ctx.actor,
    );
    await confirmPurchaseAcquisition(ctx.db, {
      purchaseId: order.shortcode,
      productId: item.id,
    });
    const result = await timeline(item.id);
    expect(
      result.groups
        .flatMap((group) => group.movements)
        .map((row) => row.kind)
        .sort(),
    ).toEqual(["acquired", "exited"]);
    expect(result.summary).toMatchObject({ spent: 0, recovered: 12 });
  });

  it("keeps an exact acquiring Expense authoritative and rejects confirmation on other link kinds", async () => {
    const { order, item } = await seed();
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Acquisition itemized",
        purchaseId: order.shortcode,
        productId: item.id,
        cost: 12,
        productQuantity: 1,
      }),
      ctx.actor,
    );
    await confirmPurchaseAcquisition(ctx.db, {
      purchaseId: order.shortcode,
      productId: item.id,
    });
    const result = await timeline(item.id);
    expect(result.groups.flatMap((group) => group.movements)).toMatchObject([
      { kind: "acquired", cost: 12, quantity: 1, provenanceOnly: false },
    ]);
    expect(result.summary.spent).toBe(12);
    const component = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Acquisition component" }),
      ctx.actor,
    );
    await expect(
      getDb(ctx.db)
        .insert(entityLink)
        .values({
          ...linkValues(
            "productComponent",
            item.entityId,
            component.entityId,
            1,
          ),
          acquisitionConfirmed: true,
        }),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "EntityLink_acquisition_confirmed_check",
      },
    });
  });
});
