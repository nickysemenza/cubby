/**
 * Purchase ↔ Product identity is the deduplicated union of live explicit links
 * and all live product-linked Expenses. Links carry provenance, never money or
 * quantity; recorded movement evidence and plans remain separate facts.
 */

import type { RelationMutationOut } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId, PurchaseId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  productMovementKind,
  type ProductMovementKind,
} from "@cubby/schemas/product";
import type {
  ProductPurchaseOut,
  PurchaseProductOut,
} from "@cubby/schemas/purchase";
import { and, asc, count, eq, inArray, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import { classifyProductMovement } from "~/lib/product-movement";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  entityLink,
  expense,
  product,
  purchase,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { linkValues, liveLinks } from "~/server/repo/entity-links";
import { expenseAcquisitionSql } from "~/server/repo/expense-aggregate-sql";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";
import { linkRelationAdapter } from "~/server/repo/relation-mutation-adapter";
import {
  emptyPreflight,
  loadRelationProducts,
  type RelationPreflight,
  relationImpact,
  throwRelationRefusal,
} from "~/server/repo/relation-preflight";

/** Acquisition-only consumers must not broaden when identity relations do. */
export const expenseAcquisitionPairPredicate = (scope: SQL) =>
  and(
    scope,
    notDeleted(expense),
    eq(expense.future, false),
    sql.raw(expenseAcquisitionSql('"Expense"')),
  );

/** A live Expense establishes identity even when it records an exit or a plan. */
const expensePairPredicate = (scope: SQL) => and(scope, notDeleted(expense));

const movementEvidenceByPair = (
  rows: readonly {
    key: string;
    cost: number | null;
    quantity: number | null;
    future: boolean;
  }[],
) => {
  const evidence = new Map<
    string,
    { movementKinds: Set<ProductMovementKind>; hasPlanned: boolean }
  >();
  for (const row of rows) {
    const pair = evidence.get(row.key) ?? {
      movementKinds: new Set<ProductMovementKind>(),
      hasPlanned: false,
    };
    if (row.future) pair.hasPlanned = true;
    else
      pair.movementKinds.add(
        classifyProductMovement(row.cost, row.quantity).kind,
      );
    evidence.set(row.key, pair);
  }
  return (key: string) => {
    const pair = evidence.get(key);
    return {
      movementKinds: productMovementKind.options.filter((kind) =>
        pair?.movementKinds.has(kind),
      ),
      hasPlanned: pair?.hasPlanned ?? false,
    };
  };
};

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
      merged.set(row.key, {
        ...existing,
        source: existing.source === "expense" ? "expense" : "both",
      });
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
      parentProductId: entityLink.fromEntityId,
      count: count(),
    })
    .from(entityLink)
    .innerJoin(
      product,
      and(eq(product.id, entityLink.toEntityId), notDeleted(product)),
    )
    .where(
      and(
        inArray(entityLink.fromEntityId, productIds),
        liveLinks("productComponent"),
      ),
    )
    .groupBy(entityLink.fromEntityId);
  for (const row of rows)
    counts.set(
      parseEntityId("product", row.parentProductId),
      Number(row.count),
    );
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
      .select({ ...productColumns, linkAttachedAt: entityLink.createdAt })
      .from(entityLink)
      .innerJoin(
        purchase,
        and(eq(purchase.id, entityLink.fromEntityId), notDeleted(purchase)),
      )
      .innerJoin(
        product,
        and(eq(product.id, entityLink.toEntityId), notDeleted(product)),
      )
      .where(
        and(
          eq(entityLink.fromEntityId, purchaseId),
          liveLinks("purchaseProduct"),
        ),
      ),
    dbc
      .select({
        ...productColumns,
        cost: expense.cost,
        quantity: expense.productQuantity,
        future: expense.future,
      })
      .from(expense)
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .innerJoin(
        product,
        and(eq(product.id, expense.productId), notDeleted(product)),
      )
      .where(expensePairPredicate(eq(expense.purchaseId, purchaseId))),
  ]);

  const movementEvidence = movementEvidenceByPair(
    expenseRows.map((row) => ({ ...row, key: row.productId })),
  );
  const rows = mergeSources<Omit<(typeof linkRows)[number], "linkAttachedAt">>(
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
    ...movementEvidence(row.productId),
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
      .select({ ...purchaseColumns, linkAttachedAt: entityLink.createdAt })
      .from(entityLink)
      .innerJoin(
        product,
        and(eq(product.id, entityLink.toEntityId), notDeleted(product)),
      )
      .innerJoin(
        purchase,
        and(eq(purchase.id, entityLink.fromEntityId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(
        and(eq(entityLink.toEntityId, productId), liveLinks("purchaseProduct")),
      ),
    dbc
      .select({
        ...purchaseColumns,
        cost: expense.cost,
        quantity: expense.productQuantity,
        future: expense.future,
      })
      .from(expense)
      .innerJoin(
        product,
        and(eq(product.id, expense.productId), notDeleted(product)),
      )
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(expensePairPredicate(eq(expense.productId, productId))),
  ]);

  const movementEvidence = movementEvidenceByPair(
    expenseRows.map((row) => ({ ...row, key: row.purchaseKey })),
  );
  const rows = mergeSources<Omit<(typeof linkRows)[number], "linkAttachedAt">>(
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
    ...movementEvidence(row.purchaseKey),
  }));
}

async function liveProductShortcodes(
  dbc: DrizzleClient,
  purchaseId: PurchaseId,
): Promise<string[]> {
  const rows = await dbc
    .select({ shortcode: product.shortcode })
    .from(entityLink)
    .innerJoin(product, eq(product.id, entityLink.toEntityId))
    .where(
      and(
        eq(entityLink.fromEntityId, purchaseId),
        liveLinks("purchaseProduct"),
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
    .select({ productId: entityLink.toEntityId })
    .from(entityLink)
    .where(
      and(
        eq(entityLink.fromEntityId, purchaseId),
        inArray(entityLink.toEntityId, [...productIds]),
        liveLinks("purchaseProduct"),
      ),
    );
  return new Set(rows.map((row) => row.productId));
}

/**
 * Everything that decides whether a purchase→product link may be written.
 *
 * Shared by `attachPurchaseProducts` (which passes its `tx`) and
 * the adapter's `preview` (which passes the pooled client); queries run
 * SEQUENTIALLY so both call sites are safe — see `repo/relation-preflight.ts`.
 *
 * There is no category gate here on purpose: an order can buy anything. The
 * only counterpart to `projectTool`'s `ineligible` bucket is the empty
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
      .insert(entityLink)
      .values(
        uniqueProductIds.map((productId) =>
          linkValues("purchaseProduct", purchaseId, productId),
        ),
      )
      .onConflictDoNothing()
      .returning({ id: entityLink.id });
    const after = await liveProductShortcodes(tx, purchaseId);

    if (inserted.length > 0) {
      await logAuditEntry(tx, actor, {
        entityKind: "purchase",
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
      .update(entityLink)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(entityLink.fromEntityId, purchaseId),
          inArray(entityLink.toEntityId, uniqueProductIds),
          liveLinks("purchaseProduct"),
        ),
      )
      .returning({ id: entityLink.id });
    const after = await liveProductShortcodes(tx, purchaseId);

    if (removed.length > 0) {
      await logAuditEntry(tx, actor, {
        entityKind: "purchase",
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

export const purchaseProductsRelationAdapter = linkRelationAdapter<
  "purchaseProduct",
  { id: string },
  PurchaseProductOut
>("purchaseProduct", {
  label: "purchase product links",
  describe: {
    attach: "Provenance links this attach would create.",
    detach: "Provenance links this detach would remove.",
  },
  list: listPurchaseProducts,
  preflight: {
    attach: preflightAttachPurchaseProducts,
    detach: preflightDetachPurchaseProducts,
  },
  attach: (db, purchaseId, targets, actor) =>
    attachPurchaseProducts(
      db,
      purchaseId,
      targets.map(({ id }) => id),
      actor,
    ),
  detach: detachPurchaseProducts,
});
