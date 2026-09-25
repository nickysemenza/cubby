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
 * stays on `Expense` (root AGENTS.md tenet: all money lives on Expense;
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

import type { RelationMutationOut } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId, PurchaseId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  ProductPurchaseOut,
  PurchaseProductOut,
} from "@cubby/schemas/purchase";
import { and, asc, count, eq, inArray, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  expense,
  product,
  productComponent,
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
import { expenseAcquisitionSql } from "~/server/repo/expense-aggregate-sql";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";
import type { EntityRelationMutationAdapter } from "~/server/repo/relation-mutation-adapter";
import {
  emptyPreflight,
  loadRelationProducts,
  planRelationAttach,
  planRelationDetach,
  type RelationPlan,
  type RelationPreflight,
  relationImpact,
  throwRelationRefusal,
} from "~/server/repo/relation-preflight";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";

/**
 * Does this Expense say the order ACQUIRED the product?
 *
 * The rule itself lives in {@link expenseAcquisitionSql} — one definition,
 * shared with the Product list's purchase-date value/sort/filter sites so the
 * two surfaces cannot disagree about what an acquisition is. Reading it as
 * "any product-linked Expense" would file 181 eBay-sale and disposal orders
 * under "products this purchase bought", and 198 pairs rest on the $0 and
 * unknown-quantity lines it deliberately keeps.
 *
 * Every consumer below queries an UNALIASED `"Expense"` (`.from(expense)` /
 * `FROM ${expense}`), so the raw-text form renders exactly as the interpolated
 * columns it replaced.
 */
const expenseIsAcquisition = sql.raw(expenseAcquisitionSql('"Expense"'));

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

/**
 * Live component-edge counts for a batch of products — how many things each is
 * made of, and therefore whether its row can be expanded.
 *
 * Same live-edge predicate as `componentCount` on the product list row and as
 * the `componentPresenceFilter` id-set, deliberately: a row that offers a
 * chevron must have children to show, and the three disagreeing is the #428
 * failure mode.
 */
const loadComponentCountsByProductId = async (
  dbc: DrizzleClient,
  productIds: ProductId[],
): Promise<Map<ProductId, number>> => {
  const counts = new Map<ProductId, number>();
  if (productIds.length === 0) return counts;
  const rows = await dbc
    .select({
      parentProductId: productComponent.parentProductId,
      count: count(),
    })
    .from(productComponent)
    .innerJoin(
      product,
      and(
        eq(product.id, productComponent.componentProductId),
        notDeleted(product),
      ),
    )
    .where(
      and(
        inArray(productComponent.parentProductId, productIds),
        notDeleted(productComponent),
      ),
    )
    .groupBy(productComponent.parentProductId);
  for (const row of rows) counts.set(row.parentProductId, Number(row.count));
  return counts;
};

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
  const [prices, coverImageUrls, componentCounts] = await Promise.all([
    loadEffectiveProductPricesById(db, productIds),
    getProductCoverImageUrlsByProductIds(db, productIds),
    loadComponentCountsByProductId(dbc, productIds),
  ]);

  return rows.map((row) => ({
    productId: parseShortcodeFor("product", row.productCode),
    productName: row.productName,
    manufacturer: row.manufacturer,
    price: prices.get(row.productId) ?? null,
    coverImageUrl: coverImageUrls.get(row.productId) ?? null,
    source: row.source,
    linkAttachedAt: row.linkAttachedAt,
    componentCount: componentCounts.get(row.productId) ?? 0,
  }));
}

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
  ).sort((a, b) => b.date.localeCompare(a.date));

  return rows.map((row) => ({
    purchaseId: parseShortcodeFor("purchase", row.purchaseCode),
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

async function livePurchaseProductIds(
  dbc: DrizzleClient | DrizzleTransaction,
  purchaseId: PurchaseId,
  productIds: readonly ProductId[],
): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const rows = await dbc
    .select({ productId: purchaseProduct.productId })
    .from(purchaseProduct)
    .where(
      and(
        eq(purchaseProduct.purchaseId, purchaseId),
        inArray(purchaseProduct.productId, [...productIds]),
        notDeleted(purchaseProduct),
      ),
    );
  return new Set(rows.map((row) => row.productId));
}

/**
 * Everything that decides whether a purchase→product link may be written.
 *
 * Shared by `attachPurchaseProducts` (which passes its `tx`) and
 * `previewAttachPurchaseProducts` (which passes the pooled client); queries run
 * SEQUENTIALLY so both call sites are safe — see `repo/relation-preflight.ts`.
 *
 * There is no category gate here on purpose: an order can buy anything. The
 * only counterpart to `ProjectToolUsage`'s `ineligible` bucket is the empty
 * one this returns.
 */
async function preflightAttachPurchaseProducts(
  dbc: DrizzleClient | DrizzleTransaction,
  purchaseId: PurchaseId,
  productIds: readonly ProductId[],
): Promise<RelationPreflight> {
  const requested = uniq([...productIds]);
  const { rows, codeById } = await loadRelationProducts(dbc, requested);
  const liveIds = new Set(rows.filter((row) => row.live).map((row) => row.id));

  const livePurchase = await dbc.query.purchase.findFirst({
    where: and(eq(purchase.id, purchaseId), notDeleted(purchase)),
    columns: { id: true },
  });
  const alreadyLive = await livePurchaseProductIds(dbc, purchaseId, requested);
  return {
    ...emptyPreflight(),
    requested,
    parentMissing: !livePurchase,
    missing: requested.filter((id) => !liveIds.has(id)),
    alreadySatisfied: requested.filter((id) => alreadyLive.has(id)),
    codeById,
  };
}

/** The detach counterpart: the only thing to know is which links exist. */
async function preflightDetachPurchaseProducts(
  dbc: DrizzleClient | DrizzleTransaction,
  purchaseId: PurchaseId,
  productIds: readonly ProductId[],
): Promise<RelationPreflight> {
  const requested = uniq([...productIds]);
  const { codeById } = await loadRelationProducts(dbc, requested);
  const alreadyLive = await livePurchaseProductIds(dbc, purchaseId, requested);
  return {
    ...emptyPreflight(),
    requested,
    alreadySatisfied: requested.filter((id) => !alreadyLive.has(id)),
    codeById,
  };
}

const PURCHASE_PRODUCT_EDGE = {
  edgeKey: "PurchaseProduct.productId",
  label: "purchase product links",
} as const;

async function previewAttachPurchaseProducts(
  db: Database,
  purchaseId: PurchaseId,
  productIds: readonly ProductId[],
): Promise<RelationPlan> {
  const pre = await preflightAttachPurchaseProducts(
    getDb(db),
    purchaseId,
    productIds,
  );
  return planRelationAttach(pre, {
    ...PURCHASE_PRODUCT_EDGE,
    description: "Provenance links this attach would create.",
  });
}

async function previewDetachPurchaseProducts(
  db: Database,
  purchaseId: PurchaseId,
  productIds: readonly ProductId[],
): Promise<RelationPlan> {
  const pre = await preflightDetachPurchaseProducts(
    getDb(db),
    purchaseId,
    productIds,
  );
  return planRelationDetach(pre, {
    ...PURCHASE_PRODUCT_EDGE,
    description: "Provenance links this detach would remove.",
  });
}

export async function attachPurchaseProducts(
  db: Database,
  purchaseId: PurchaseId,
  productIds: ProductId[],
  actor: ActorContext,
): Promise<RelationMutationOut> {
  const uniqueProductIds = uniq(productIds);
  return withTransaction(db, async (tx) => {
    // On `tx`, not the pooled client: these checks and the insert below must
    // see one snapshot.
    const pre = await preflightAttachPurchaseProducts(
      tx,
      purchaseId,
      uniqueProductIds,
    );
    if (pre.parentMissing) {
      throw createAppError(
        "PURCHASE_NOT_FOUND",
        `Purchase ${purchaseId} not found`,
      );
    }
    if (pre.missing.length > 0) {
      throwRelationRefusal({
        reason: "PRODUCT_NOT_FOUND",
        ids: pre.missing,
        codeById: pre.codeById,
        message: (codes) =>
          `Every linked Product must exist and be live. Not live: ${codes}.`,
        items: [
          relationImpact({
            code: "block-relation-target-not-live",
            label: "products that are not live",
            description:
              "A Product named here does not exist or has been deleted.",
            ids: pre.missing,
          }),
        ],
      });
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
    // Every id in `uniqueProductIds` was already confirmed live above, so the
    // only reason one wouldn't land in `inserted` is `onConflictDoNothing`
    // skipping an edge that was already there — the no-op bucket.
    return {
      changed: inserted.length,
      attached: after.length,
      alreadySatisfied: uniqueProductIds.length - inserted.length,
    };
  });
}

export async function detachPurchaseProducts(
  db: Database,
  purchaseId: PurchaseId,
  productIds: ProductId[],
  actor: ActorContext,
): Promise<RelationMutationOut> {
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
    // Unlike attach, a requested id here was never confirmed live — it may
    // never have been linked at all. Either way (never linked, or linked and
    // already removed), the outcome is the same "no live edge", so whatever
    // wasn't removed was already in the detached state being asked for.
    return {
      changed: removed.length,
      attached: after.length,
      alreadySatisfied: uniqueProductIds.length - removed.length,
    };
  });
}

export const purchaseProductsRelationAdapter = {
  preview(db, action, ownerId, targetIds) {
    const purchaseId = parseEntityId("purchase", ownerId);
    const productIds = targetIds.map((id) => parseEntityId("product", id));
    return action === "attach"
      ? previewAttachPurchaseProducts(db, purchaseId, productIds)
      : previewDetachPurchaseProducts(db, purchaseId, productIds);
  },
  async execute(ctx, action, ownerShortcode, items) {
    const purchaseId = await resolveOrThrow(ctx.db, "purchase", ownerShortcode);
    const productIds = await resolveAllOrThrow(
      ctx.db,
      "product",
      items.map(({ id }) => id),
    );
    return action === "attach"
      ? attachPurchaseProducts(ctx.db, purchaseId, productIds, ctx.actorContext)
      : detachPurchaseProducts(
          ctx.db,
          purchaseId,
          productIds,
          ctx.actorContext,
        );
  },
} satisfies EntityRelationMutationAdapter<{ id: string }>;
