/**
 * `PurchaseProduct` — the provenance link between an order and the Products it
 * bought. The cases that matter are the ones the partial-unique index makes
 * non-obvious: re-attaching after a detach, and what a merge does when both
 * sides already name the same pair (a bare re-point would abort the whole
 * transaction on the unique index rather than produce a wrong answer).
 */
import type { ProductShortcode, PurchaseId } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { purchaseProduct } from "~/server/db/schema";

import { getDb, notDeleted } from "./database-helpers";
import { createExpense } from "./expense";
import { mergeProducts } from "./product/merge";
import {
  attachPurchaseProducts,
  detachPurchaseProducts,
  listProductPurchases,
  listPurchaseProducts,
} from "./purchase-products";
import {
  createProductFixture as createProduct,
  makeExpenseInput,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";
import { findOrCreateVendor } from "./vendor";

describe("purchase ↔ product links", () => {
  const ctx = withTestDb();

  const mkPurchase = async (label: string, vendorName = "Link Test Vendor") => {
    const vendorId = await findOrCreateVendor(ctx.db, vendorName);
    return insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2026-02-01",
      displayLabel: label,
    });
  };

  const livePairs = (purchaseId: PurchaseId) =>
    getDb(ctx.db)
      .select({ productId: purchaseProduct.productId })
      .from(purchaseProduct)
      .where(
        and(
          eq(purchaseProduct.purchaseId, purchaseId),
          notDeleted(purchaseProduct),
        ),
      );

  // The Expense leg. These reads answer "which order acquired this", and the
  // Expense ledger — not `PurchaseProduct` — establishes that for all but a
  // handful of pairs. Every case below was invisible before the union landed.
  describe("expense-derived rows", () => {
    // `productId` here is the product SHORTCODE — `createExpense` resolves it,
    // unlike the list functions below, which take the branded id (`entityId`).
    const expenseOn = async (args: {
      name: string;
      cost: number;
      productId: ProductShortcode;
      productQuantity: number | null;
      orderId: string;
      future?: boolean;
    }) =>
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            date: "2026-03-01",
            vendor: "Expense Leg Vendor",
            ...args,
          }),
        ),
        ctx.actor,
      );

    it("does NOT list an order whose only expense is an exit", async () => {
      const camera = await createProduct(
        ctx.db,
        makeProductInput({ name: "Union Camera" }),
        ctx.actor,
      );
      // A negative line is a sale/return/disposal. A disposal Purchase must not
      // claim to have BOUGHT the thing it sold — the section's contract says
      // acquired. 181 live pairs depend on this exclusion.
      await expenseOn({
        name: "Union Camera sold",
        cost: -250,
        productId: camera.id,
        productQuantity: -1,
        orderId: "UNION-SALE",
      });

      expect(await listProductPurchases(ctx.db, camera.entityId)).toEqual([]);
    });

    it("keeps an order whose refund sits beside a real acquisition", async () => {
      const saw = await createProduct(
        ctx.db,
        makeProductInput({ name: "Union Saw" }),
        ctx.actor,
      );
      await expenseOn({
        name: "Union Saw",
        cost: 120,
        productId: saw.id,
        productQuantity: 1,
        orderId: "UNION-REFUND",
      });
      // A partial refund on a kept item, and a returned second unit, are both
      // ordinary inside an order that still bought something.
      await expenseOn({
        name: "Union Saw price adjustment",
        cost: -20,
        productId: saw.id,
        productQuantity: 0,
        orderId: "UNION-REFUND",
      });

      const purchases = await listProductPurchases(ctx.db, saw.entityId);
      expect(purchases).toHaveLength(1);
      expect(purchases[0]?.source).toBe("expense");
    });
  });

  it("attaches idempotently, lists both directions, and detaches", async () => {
    const order = await mkPurchase("appliances");
    const range = await createProduct(
      ctx.db,
      makeProductInput({ name: "Link Range" }),
      ctx.actor,
    );
    const fridge = await createProduct(
      ctx.db,
      makeProductInput({ name: "Link Fridge" }),
      ctx.actor,
    );

    const first = await attachPurchaseProducts(
      ctx.db,
      order.id,
      [range.entityId, fridge.entityId],
      ctx.actor,
    );
    expect(first).toEqual({ changed: 2, attached: 2, alreadySatisfied: 0 });

    // Idempotent: the partial unique absorbs the repeat rather than erroring.
    // `alreadySatisfied: 1` is the substantiation for that idempotency claim —
    // the one requested id that needed no write because it was already live.
    const repeat = await attachPurchaseProducts(
      ctx.db,
      order.id,
      [range.entityId],
      ctx.actor,
    );
    expect(repeat).toEqual({ changed: 0, attached: 2, alreadySatisfied: 1 });

    const products = await listPurchaseProducts(ctx.db, order.id);
    expect(products.map((p) => p.productName)).toEqual([
      "Link Fridge",
      "Link Range",
    ]);

    const purchases = await listProductPurchases(ctx.db, range.entityId);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]?.displayLabel).toBe("appliances");

    const detached = await detachPurchaseProducts(
      ctx.db,
      order.id,
      [fridge.entityId],
      ctx.actor,
    );
    expect(detached).toEqual({ changed: 1, attached: 1, alreadySatisfied: 0 });
    expect(await livePairs(order.id)).toHaveLength(1);

    // Detaching something already gone is a no-op, not an error — and now
    // `alreadySatisfied` says exactly that, rather than leaving `changed: 0`
    // to stand for both "no-op" and "rejected".
    const again = await detachPurchaseProducts(
      ctx.db,
      order.id,
      [fridge.entityId],
      ctx.actor,
    );
    expect(again).toEqual({ changed: 0, attached: 1, alreadySatisfied: 1 });
  });

  /**
   * PRODUCT_NOT_FOUND: the shared `relation-preflight.ts` refusal for a
   * target that plainly does not resolve any more — here, a soft-deleted
   * product named by a stale id.
   */

  it("folds to exactly one live pair when merging two products onto the same order", async () => {
    // Both products link the SAME purchase, so a blind re-point would violate
    // the partial unique and abort. `foldAssociation` re-points what fits and
    // soft-deletes the collision.
    const order = await mkPurchase("product merge");
    const keeper = await createProduct(
      ctx.db,
      makeProductInput({ name: "Merge Keeper" }),
      ctx.actor,
    );
    const loser = await createProduct(
      ctx.db,
      makeProductInput({ name: "Merge Loser" }),
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      order.id,
      [keeper.entityId, loser.entityId],
      ctx.actor,
    );

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );
    expect(summary.purchaseLinksMoved).toBe(0);

    const pairs = await livePairs(order.id);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.productId).toBe(keeper.entityId);
  });
});
