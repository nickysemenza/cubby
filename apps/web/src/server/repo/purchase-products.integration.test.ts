/**
 * `PurchaseProduct` — the provenance link between an order and the Products it
 * bought. The cases that matter are the ones the partial-unique index makes
 * non-obvious: re-attaching after a detach, and what a merge does when both
 * sides already name the same pair (a bare re-point would abort the whole
 * transaction on the unique index rather than produce a wrong answer).
 */
import type { PurchaseId } from "@cubby/schemas/identifiers";
import { unsafePurchaseShortcode } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { auditLog, purchaseProduct } from "~/server/db/schema";
import { getDb, notDeleted } from "./database-helpers";
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
    expect(first).toEqual({ changed: 2, attached: 2 });

    // Idempotent: the partial unique absorbs the repeat rather than erroring.
    const repeat = await attachPurchaseProducts(
      ctx.db,
      order.id,
      [range.entityId],
      ctx.actor,
    );
    expect(repeat).toEqual({ changed: 0, attached: 2 });

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
    expect(detached).toEqual({ changed: 1, attached: 1 });
    expect(await livePairs(order.id)).toHaveLength(1);

    // Detaching something already gone is a no-op, not an error.
    const again = await detachPurchaseProducts(
      ctx.db,
      order.id,
      [fridge.entityId],
      ctx.actor,
    );
    expect(again.changed).toBe(0);
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

    expect(reattached).toEqual({ changed: 1, attached: 1 });
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
