/**
 * `PurchaseProduct` — the provenance link between an order and the Products it
 * bought. The cases that matter are the ones the partial-unique index makes
 * non-obvious: re-attaching after a detach, and what a merge does when both
 * sides already name the same pair (a bare re-point would abort the whole
 * transaction on the unique index rather than produce a wrong answer).
 */
import type { ProductShortcode, PurchaseId } from "@cubby/schemas/identifiers";
import { unsafePurchaseShortcode } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { auditLog, purchaseProduct } from "~/server/db/schema";
import { getDb, notDeleted } from "./database-helpers";
import { createExpense } from "./expense";
import { deleteProducts } from "./product";
import { mergeProducts } from "./product/merge";
import { mergePurchases } from "./purchase";
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
import { resolveOrThrow } from "./shortcode-resolver";
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

    it("lists an order named only by an itemized expense, undetachable", async () => {
      const drill = await createProduct(
        ctx.db,
        makeProductInput({ name: "Union Drill" }),
        ctx.actor,
      );
      await expenseOn({
        name: "Union Drill",
        cost: 99,
        productId: drill.id,
        productQuantity: 1,
        orderId: "UNION-1",
      });

      const purchases = await listProductPurchases(ctx.db, drill.entityId);
      expect(purchases).toHaveLength(1);
      expect(purchases[0]?.source).toBe("expense");
      expect(purchases[0]?.linkAttachedAt).toBeNull();
    });

    it("collapses several expense lines for one pair into one row", async () => {
      const bolt = await createProduct(
        ctx.db,
        makeProductInput({ name: "Union Bolt" }),
        ctx.actor,
      );
      for (const suffix of ["a", "b", "c"]) {
        await expenseOn({
          name: `Union Bolt ${suffix}`,
          cost: 3,
          productId: bolt.id,
          productQuantity: 1,
          orderId: "UNION-DEDUP",
        });
      }

      const purchases = await listProductPurchases(ctx.db, bolt.entityId);
      expect(purchases).toHaveLength(1);

      const purchaseId = unsafePurchaseShortcode(
        purchases[0]?.purchaseId ?? "",
      );
      const products = await listPurchaseProducts(
        ctx.db,
        await resolveOrThrow(ctx.db, "purchase", purchaseId),
      );
      expect(products.filter((row) => row.productId === bolt.id)).toHaveLength(
        1,
      );
    });

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

    it("counts a $0 line as an acquisition but a $0 discard as an exit", async () => {
      const promo = await createProduct(
        ctx.db,
        makeProductInput({ name: "Union Promo" }),
        ctx.actor,
      );
      const tossed = await createProduct(
        ctx.db,
        makeProductInput({ name: "Union Tossed" }),
        ctx.actor,
      );
      // With no money to read, the quantity's sign IS the fact — the ledger
      // rule this predicate borrows. A free promo item arrived; a write-off
      // left.
      await expenseOn({
        name: "Union Promo freebie",
        cost: 0,
        productId: promo.id,
        productQuantity: 1,
        orderId: "UNION-ZERO",
      });
      await expenseOn({
        name: "Union Tossed write-off",
        cost: 0,
        productId: tossed.id,
        productQuantity: -1,
        orderId: "UNION-ZERO-OUT",
      });

      expect(await listProductPurchases(ctx.db, promo.entityId)).toHaveLength(
        1,
      );
      expect(await listProductPurchases(ctx.db, tossed.entityId)).toEqual([]);
    });

    it("ignores a planned expense", async () => {
      const planned = await createProduct(
        ctx.db,
        makeProductInput({ name: "Union Planned" }),
        ctx.actor,
      );
      await expenseOn({
        name: "Union Planned buy",
        cost: 500,
        productId: planned.id,
        productQuantity: 1,
        orderId: "UNION-FUTURE",
        future: true,
      });

      expect(await listProductPurchases(ctx.db, planned.entityId)).toEqual([]);
    });

    it("reports a pair carrying both edges once, and keeps it detachable", async () => {
      const both = await createProduct(
        ctx.db,
        makeProductInput({ name: "Union Both" }),
        ctx.actor,
      );
      await expenseOn({
        name: "Union Both",
        cost: 60,
        productId: both.id,
        productQuantity: 1,
        orderId: "UNION-BOTH",
      });
      const [row] = await listProductPurchases(ctx.db, both.entityId);
      const orderId = await resolveOrThrow(
        ctx.db,
        "purchase",
        unsafePurchaseShortcode(row?.purchaseId ?? ""),
      );
      await attachPurchaseProducts(ctx.db, orderId, [both.entityId], ctx.actor);

      const purchases = await listProductPurchases(ctx.db, both.entityId);
      expect(purchases).toHaveLength(1);
      expect(purchases[0]?.source).toBe("both");
      expect(purchases[0]?.linkAttachedAt).not.toBeNull();

      // Detaching drops to expense-only rather than removing the row.
      await detachPurchaseProducts(ctx.db, orderId, [both.entityId], ctx.actor);
      const after = await listProductPurchases(ctx.db, both.entityId);
      expect(after).toHaveLength(1);
      expect(after[0]?.source).toBe("expense");
      expect(after[0]?.linkAttachedAt).toBeNull();
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
  it("refuses to attach a soft-deleted product, naming it in the refusal", async () => {
    const order = await mkPurchase("dead product order");
    const gone = await createProduct(
      ctx.db,
      makeProductInput({ name: "Gone Before Attach" }),
      ctx.actor,
    );
    await deleteProducts(ctx.db, [gone.entityId], ctx.actor);

    await expect(
      attachPurchaseProducts(ctx.db, order.id, [gone.entityId], ctx.actor),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      cause: { reason: "PRODUCT_NOT_FOUND" },
    });

    expect(await livePairs(order.id)).toHaveLength(0);
  });

  it("allows re-attaching a detached pair — the unique index is partial", async () => {
    const order = await mkPurchase("re-attach");
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Re-attach Product" }),
      ctx.actor,
    );

    await attachPurchaseProducts(ctx.db, order.id, [prod.entityId], ctx.actor);
    await detachPurchaseProducts(ctx.db, order.id, [prod.entityId], ctx.actor);
    const reattached = await attachPurchaseProducts(
      ctx.db,
      order.id,
      [prod.entityId],
      ctx.actor,
    );

    expect(reattached).toEqual({
      changed: 1,
      attached: 1,
      alreadySatisfied: 0,
    });
    expect(await livePairs(order.id)).toHaveLength(1);
  });

  it("writes an audit entry naming the link set before and after", async () => {
    const order = await mkPurchase("audited");
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Audited Product" }),
      ctx.actor,
    );
    await attachPurchaseProducts(ctx.db, order.id, [prod.entityId], ctx.actor);

    const entries = await getDb(ctx.db)
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "purchase"),
          eq(auditLog.entityId, order.id),
        ),
      );

    const linkChange = entries.find(
      (e) =>
        (e.changes as { linkedProductIds?: { to?: string[] } } | null)
          ?.linkedProductIds !== undefined,
    );
    expect(linkChange).toBeDefined();
    const changes = linkChange?.changes as {
      linkedProductIds: { from: string[]; to: string[] };
    };
    expect(changes.linkedProductIds.from).toEqual([]);
    expect(changes.linkedProductIds.to).toHaveLength(1);
  });

  it("refuses to delete a Product whose purchase link is live", async () => {
    const order = await mkPurchase("blocks delete");
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Blocking Link Product" }),
      ctx.actor,
    );
    await attachPurchaseProducts(ctx.db, order.id, [prod.entityId], ctx.actor);

    await expect(
      deleteProducts(ctx.db, [prod.entityId], ctx.actor),
    ).rejects.toMatchObject({
      cause: { reason: "PRODUCT_HAS_PURCHASE_LINKS" },
    });
  });

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

  it("moves a merged product's link onto the survivor when the survivor lacks it", async () => {
    const order = await mkPurchase("product merge move");
    const keeper = await createProduct(
      ctx.db,
      makeProductInput({ name: "Move Keeper" }),
      ctx.actor,
    );
    const loser = await createProduct(
      ctx.db,
      makeProductInput({ name: "Move Loser" }),
      ctx.actor,
    );
    await attachPurchaseProducts(ctx.db, order.id, [loser.entityId], ctx.actor);

    const summary = await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );
    expect(summary.purchaseLinksMoved).toBe(1);

    const pairs = await livePairs(order.id);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.productId).toBe(keeper.entityId);
  });

  it("folds to exactly one live pair when merging two purchases naming the same product", async () => {
    const survivor = await mkPurchase("survivor", "Merge Purchase Vendor");
    const absorbed = await mkPurchase("absorbed", "Merge Purchase Vendor");
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Shared Across Orders" }),
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      survivor.id,
      [prod.entityId],
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      absorbed.id,
      [prod.entityId],
      ctx.actor,
    );

    await mergePurchases(
      ctx.db,
      {
        keepId: unsafePurchaseShortcode(survivor.shortcode),
        mergeIds: [unsafePurchaseShortcode(absorbed.shortcode)],
      },
      ctx.actor,
    );

    expect(await livePairs(survivor.id)).toHaveLength(1);
    expect(await livePairs(absorbed.id)).toHaveLength(0);
  });
});
