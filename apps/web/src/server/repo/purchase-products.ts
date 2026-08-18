/**
 * Which Products a Purchase acquired, and the transpose — answered from TWO
 * sources, because one of them alone cannot answer it.
 *
 * `PurchaseProduct` is a deliberately SPARSE provenance edge. It exists because
 * an installment/lump-sum Purchase's Expenses are `lineBasis: "allocation"`
 * (see `packages/schemas/src/expense-line-kind.ts`) and can never carry a
 * `productId`. An allocation is a slice of a total that was never itemized —
 * money cut by payment schedule (a deposit buys no particular item) or by an
 * estimated materials/labor split — so pointing products at one would halve
 * every derived unit price and claim phantom units. Without this table those
 * goods had no path at all back to the order that bought them.
 *
 * Which means it was never a mirror of the ordinary case, and reading it as one
 * was a bug: on live data 13 link rows exist against 9,609 pairs the Expense
 * ledger already establishes, so these reads returned nothing for 5,328 of
 * 5,614 products while the Expense History beside them named the order. Both
 * legs are now unioned per pair — see {@link expenseIsAcquisition} for which
 * Expenses count, which is the part that is easy to get wrong.
 *
 * Backfilling the 9,606 missing rows was rejected: it would duplicate an edge
 * that already exists and demand a sync rule on every Expense write, including
 * purchase reparenting. The join still carries NO money and NO quantity — that
 * stays on `Expense` (root CLAUDE.md tenet: all money lives on Expense;
 * `purchase.statedTotal` is never summed into spend).
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
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleClient } from "~/server/db";
import {
  expense,
  product,
  purchase,
  purchaseProduct,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";

/**
 * Does this Expense say the order ACQUIRED the product?
 *
 * A product-linked Expense is not automatically evidence that the purchase
 * bought the thing: a negative one records an **exit** — a sale, a return, a
 * disposal — and a disposal is modelled as a Purchase whose Expenses sum
 * negative (`repo/product/ownership.ts`). Unioning every product-linked
 * Expense into these reads would therefore file 181 eBay-sale and disposal
 * orders under "products this purchase bought", which is a different relation,
 * not a fuller one. That is the whole reason this predicate exists; deleting it
 * silently reintroduces the wrong rows.
 *
 * The rule is the ledger's own, documented on `Expense.productQuantity` and
 * implemented in `product/quantity-ledger.ts`: money direction wins, and the
 * quantity's sign is consulted only when there is no money. So a row is an exit
 * when its cost is negative, or when it moved no money and its quantity is
 * negative (a discard). Everything else counts, deliberately including the $0
 * and unknown-quantity lines — a free promo item or an unpriced line is still a
 * unit that arrived, and 198 pairs rest on that.
 */
const expenseIsAcquisition = sql`(
  ${expense.cost} > 0
  OR (
    COALESCE(${expense.cost}, 0) = 0
    AND COALESCE(${expense.productQuantity}, 0) >= 0
  )
)`;

/**
 * The pairs one side of the relation contributes from the Expense ledger.
 *
 * `future` rows are excluded on their own terms rather than by copying
 * `movement-timeline`'s filter: a planned expense has not bought anything yet.
 * (It is currently moot — no pair touches a future expense — but the rule
 * should not depend on that staying true.)
 */
export const expensePairPredicate = (scope: SQL) =>
  and(
    scope,
    notDeleted(expense),
    eq(expense.future, false),
    expenseIsAcquisition,
  );

/**
 * Fold the two legs into one row per pair.
 *
 * A purchase can name the same product on several Expense lines — a 30-line
 * Home Depot order, three lines for the same bolt — so the expense leg is
 * deduplicated by pair rather than rendered per line. This is where these reads
 * diverge from `movement-timeline`, which renders one row per *expense* and so
 * never meets the collision.
 *
 * Precedence also diverges, deliberately. There the Expense edge SUPPRESSES the
 * provenance row, because a movement is about money and the itemized row is the
 * better record of it. Here the row is about *which order*, and an explicit link
 * must stay detachable, so an overlapping pair keeps its `linkAttachedAt` and
 * reports `source: "both"`.
 */
const mergeSources = <T>(
  linkRows: readonly (T & { key: string; linkAttachedAt: Date })[],
  expenseRows: readonly (T & { key: string })[],
): (T & {
  source: "expense" | "link" | "both";
  linkAttachedAt: Date | null;
})[] => {
  const merged = new Map<
    string,
    T & { source: "expense" | "link" | "both"; linkAttachedAt: Date | null }
  >();
  for (const row of linkRows) {
    merged.set(row.key, {
      ...row,
      source: "link",
      linkAttachedAt: row.linkAttachedAt,
    });
  }
  for (const row of expenseRows) {
    const existing = merged.get(row.key);
    if (existing) {
      merged.set(row.key, { ...existing, source: "both" });
      continue;
    }
    merged.set(row.key, { ...row, source: "expense", linkAttachedAt: null });
  }
  return [...merged.values()];
};

/** The Products linked to one Purchase, alphabetically by name. */
export async function listPurchaseProducts(
  db: Database,
  purchaseId: PurchaseId,
): Promise<PurchaseProductOut[]> {
  const dbc = getDb(db);
  const productColumns = {
    productId: product.id,
    productCode: product.shortcode,
    productName: product.name,
    manufacturer: product.manufacturer,
  };

  const [linkRows, expenseRows] = await Promise.all([
    dbc
      .select({ ...productColumns, linkAttachedAt: purchaseProduct.createdAt })
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
      ),
    dbc
      .selectDistinct(productColumns)
      .from(expense)
      .innerJoin(
        product,
        and(eq(product.id, expense.productId), notDeleted(product)),
      )
      .where(expensePairPredicate(eq(expense.purchaseId, purchaseId))),
  ]);

  const rows = mergeSources(
    linkRows.map((row) => ({ ...row, key: row.productId })),
    expenseRows.map((row) => ({ ...row, key: row.productId })),
  ).sort((a, b) => a.productName.localeCompare(b.productName));

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
    source: row.source,
    linkAttachedAt: row.linkAttachedAt,
  }));
}

/** The transpose: every Purchase one Product is linked to, most recent first. */
export async function listProductPurchases(
  db: Database,
  productId: ProductId,
): Promise<ProductPurchaseOut[]> {
  const dbc = getDb(db);
  const purchaseColumns = {
    purchaseKey: purchase.id,
    purchaseCode: purchase.shortcode,
    displayLabel: purchase.displayLabel,
    date: purchase.date,
    orderId: purchase.orderId,
    vendorName: vendor.name,
  };
  // Left join, gated on the vendor's own liveness: a soft-deleted vendor's
  // name should read as absent here, the same way `purchaseVendorName` in
  // repo/purchase.ts goes null rather than surfacing a retired name.
  const liveVendor = and(eq(vendor.id, purchase.vendorId), notDeleted(vendor));

  const [linkRows, expenseRows] = await Promise.all([
    dbc
      .select({ ...purchaseColumns, linkAttachedAt: purchaseProduct.createdAt })
      .from(purchaseProduct)
      .innerJoin(
        purchase,
        and(eq(purchase.id, purchaseProduct.purchaseId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(
        and(
          eq(purchaseProduct.productId, productId),
          notDeleted(purchaseProduct),
        ),
      ),
    dbc
      .selectDistinct(purchaseColumns)
      .from(expense)
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(expensePairPredicate(eq(expense.productId, productId))),
  ]);

  const rows = mergeSources(
    linkRows.map((row) => ({ ...row, key: row.purchaseKey })),
    expenseRows.map((row) => ({ ...row, key: row.purchaseKey })),
    // `date` is a plain-date string, so a lexical compare is a date compare.
  ).sort((a, b) => b.date.localeCompare(a.date));

  return rows.map((row) => ({
    purchaseId: unsafePurchaseShortcode(row.purchaseCode),
    displayLabel: row.displayLabel,
    date: row.date,
    vendorName: row.vendorName,
    orderId: row.orderId,
    source: row.source,
    linkAttachedAt: row.linkAttachedAt,
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
