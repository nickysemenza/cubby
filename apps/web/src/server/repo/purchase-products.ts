/**
 * Purchase ⟷ Product links (`PurchaseProduct`) — which Products a Purchase
 * bought, and nothing else. This join carries NO money and NO quantity: that
 * stays on `Expense` (see root CLAUDE.md tenet — all money lives on Expense;
 * `purchase.statedTotal` is never summed into spend). It exists because an
 * installment/lump-sum Purchase's Expenses are `lineBasis: "allocation"` (see
 * `packages/schemas/src/expense-line-kind.ts`) and can never carry a
 * `productId`. An allocation is a slice of a total that was never itemized —
 * money cut by payment schedule (a deposit buys no particular item) or by an
 * estimated materials/labor split — so pointing products at one would halve
 * every derived unit price and claim phantom units. Without this table those
 * goods had no path at all back to the order that bought them.
 *
 * Mirrors `attachProjectResources` / `detachProjectResources` /
 * `listProjectResources` in `repo/project/tools.ts` as closely as possible —
 * same transaction shape, same liveness checks, same `onConflictDoNothing`
 * insert against the partial-unique index, same before/after audit diff.
 * Deliberately NOT mirrored: `assertNoTimelineConflict`, which polices tool
 * *ownership windows* against a project's dates — there is no analogous
 * concept for a plain purchase/product link.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId, PurchaseId } from "@cubby/schemas/identifiers";
import {
  unsafeProductShortcode,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type {
  ProductPurchaseOut,
  PurchaseProductOut,
} from "@cubby/schemas/purchase";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleClient } from "~/server/db";
import { product, purchase, purchaseProduct, vendor } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";

/** The Products linked to one Purchase, alphabetically by name. */
export async function listPurchaseProducts(
  db: Database,
  purchaseId: PurchaseId,
): Promise<PurchaseProductOut[]> {
  const dbc = getDb(db);
  const rows = await dbc
    .select({
      productId: product.id,
      productCode: product.shortcode,
      productName: product.name,
      manufacturer: product.manufacturer,
      attachedAt: purchaseProduct.createdAt,
    })
    .from(purchaseProduct)
    .innerJoin(
      product,
      and(eq(product.id, purchaseProduct.productId), notDeleted(product)),
    )
    .where(
      and(
        eq(purchaseProduct.purchaseId, purchaseId),
        notDeleted(purchaseProduct),
      ),
    )
    .orderBy(asc(product.name));

  const productIds = rows.map((row) => row.productId);
  const [prices, coverImageUrls] = await Promise.all([
    loadEffectiveProductPricesById(db, productIds),
    getProductCoverImageUrlsByProductIds(db, productIds),
  ]);

  return rows.map((row) => ({
    productId: unsafeProductShortcode(row.productCode),
    productName: row.productName,
    manufacturer: row.manufacturer,
    price: prices.get(row.productId) ?? null,
    coverImageUrl: coverImageUrls.get(row.productId) ?? null,
    attachedAt: row.attachedAt,
  }));
}

/** The transpose: every Purchase one Product is linked to, most recent first. */
export async function listProductPurchases(
  db: Database,
  productId: ProductId,
): Promise<ProductPurchaseOut[]> {
  const rows = await getDb(db)
    .select({
      purchaseCode: purchase.shortcode,
      displayLabel: purchase.displayLabel,
      date: purchase.date,
      orderId: purchase.orderId,
      vendorName: vendor.name,
      attachedAt: purchaseProduct.createdAt,
    })
    .from(purchaseProduct)
    .innerJoin(
      purchase,
      and(eq(purchase.id, purchaseProduct.purchaseId), notDeleted(purchase)),
    )
    // Left join, gated on the vendor's own liveness: a soft-deleted vendor's
    // name should read as absent here, the same way `purchaseVendorName` in
    // repo/purchase.ts goes null rather than surfacing a retired name.
    .leftJoin(vendor, and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)))
    .where(
      and(
        eq(purchaseProduct.productId, productId),
        notDeleted(purchaseProduct),
      ),
    )
    .orderBy(desc(purchase.date));

  return rows.map((row) => ({
    purchaseId: unsafePurchaseShortcode(row.purchaseCode),
    displayLabel: row.displayLabel,
    date: row.date,
    vendorName: row.vendorName,
    orderId: row.orderId,
    attachedAt: row.attachedAt,
  }));
}

async function liveProductShortcodes(
  dbc: DrizzleClient,
  purchaseId: PurchaseId,
): Promise<string[]> {
  const rows = await dbc
    .select({ shortcode: product.shortcode })
    .from(purchaseProduct)
    .innerJoin(product, eq(product.id, purchaseProduct.productId))
    .where(
      and(
        eq(purchaseProduct.purchaseId, purchaseId),
        notDeleted(purchaseProduct),
        notDeleted(product),
      ),
    )
    .orderBy(asc(product.shortcode));
  return rows.map((row) => row.shortcode);
}

export async function attachPurchaseProducts(
  db: Database,
  purchaseId: PurchaseId,
  productIds: ProductId[],
  actor: ActorContext,
): Promise<{ changed: number; attached: number }> {
  const uniqueProductIds = uniq(productIds);
  return withTransaction(db, async (tx) => {
    const livePurchase = await tx.query.purchase.findFirst({
      where: and(eq(purchase.id, purchaseId), notDeleted(purchase)),
      columns: { id: true },
    });
    if (!livePurchase) {
      throw createAppError(
        "PURCHASE_NOT_FOUND",
        `Purchase ${purchaseId} not found`,
      );
    }

    const liveProducts = await tx.query.product.findMany({
      where: and(inArray(product.id, uniqueProductIds), notDeleted(product)),
      columns: { id: true },
    });
    if (liveProducts.length !== uniqueProductIds.length) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        "Every linked Product must exist and be live.",
      );
    }

    const before = await liveProductShortcodes(tx, purchaseId);
    const inserted = await tx
      .insert(purchaseProduct)
      .values(uniqueProductIds.map((productId) => ({ purchaseId, productId })))
      .onConflictDoNothing()
      .returning({ id: purchaseProduct.id });
    const after = await liveProductShortcodes(tx, purchaseId);

    if (inserted.length > 0) {
      await logAuditEntry(tx, actor, {
        entityType: "purchase",
        entityId: purchaseId,
        action: "update",
        changes: { linkedProductIds: { from: before, to: after } },
      });
    }
    return { changed: inserted.length, attached: after.length };
  });
}

export async function detachPurchaseProducts(
  db: Database,
  purchaseId: PurchaseId,
  productIds: ProductId[],
  actor: ActorContext,
): Promise<{ changed: number; attached: number }> {
  const uniqueProductIds = uniq(productIds);
  return withTransaction(db, async (tx) => {
    const before = await liveProductShortcodes(tx, purchaseId);
    const removed = await tx
      .update(purchaseProduct)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(purchaseProduct.purchaseId, purchaseId),
          inArray(purchaseProduct.productId, uniqueProductIds),
          notDeleted(purchaseProduct),
        ),
      )
      .returning({ id: purchaseProduct.id });
    const after = await liveProductShortcodes(tx, purchaseId);

    if (removed.length > 0) {
      await logAuditEntry(tx, actor, {
        entityType: "purchase",
        entityId: purchaseId,
        action: "update",
        changes: { linkedProductIds: { from: before, to: after } },
      });
    }
    return { changed: removed.length, attached: after.length };
  });
}
