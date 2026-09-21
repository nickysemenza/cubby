/**
 * What's inside a kit (`ProductComponent`) — one Product's own component
 * list, and the transpose (which kits a Product is listed inside).
 *
 * A combo tool kit or a multi-pack is a Product like any other: it keeps its
 * own UPC, model, ASIN, image, and purchase history. `ProductComponent` is
 * the only place that records what it's made of, so splitting a kit no
 * longer means deleting the kit Product outright (destroying that identity
 * and provenance) — the kit survives, and this table says what came out of
 * it. One row per distinct component; a 4-pack of one part is one row with
 * `quantity: 4`, a 9-piece kit is nine rows.
 *
 * Mirrors `attachPurchaseProducts` / `detachPurchaseProducts` /
 * `listPurchaseProducts` in `repo/purchase-products.ts` as closely as the
 * extra `quantity` field allows: same transaction shape, same liveness
 * checks, same partial-unique-index insert, same before/after audit diff.
 * Quantity is set at attach time; changing it is detach-then-reattach, not an
 * in-place update — the same "no edit path" precedent `PurchaseProduct`
 * sets, kept for the same reason: one fewer write shape to keep consistent
 * with the audit diff.
 */

import type { RelationMutationOut } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  KitComponentRowOut,
  KitMembershipOut,
  KitMembershipPurchaseOut,
  ProductComponentOut,
} from "@cubby/schemas/product-components";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { uniq, uniqBy } from "es-toolkit";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  expense,
  product,
  productComponent,
  purchase,
  purchaseProduct,
  vendor,
} from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  getDb,
  notDeleted,
  relations,
  withTransaction,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { getProductCoverImageUrlsByProductIds } from "~/server/repo/product";
import { markProductConversionCoverageInputStale } from "~/server/repo/product/conversion-coverage";
import { enrichProductListItems } from "~/server/repo/product/list-enrichment";
import { dbProductToListAPI } from "~/server/repo/product/mappers";
// `findMergeComponentCycle` is the SAME question `mergeProducts` already
// answers — "does identifying/adding these edges make a product reach
// itself" — reused here rather than reimplemented. Called with `loserIds: []`
// it degrades from "would identifying these nodes create a cycle" to plain
// "does keepId reach itself over this edge set", which is exactly the attach
// question: no node identification happens on attach, only new edges.
import { findMergeComponentCycle } from "~/server/repo/product/merge";
import {
  enrichProductRowsWithPricing,
  loadEffectiveProductPricesById,
} from "~/server/repo/product/pricing";
import {
  enrichProductRowsWithQuantityLedger,
  loadProductPickerQuantities,
} from "~/server/repo/product/quantity-ledger";
// The one rule for "does this Expense say the order bought the product" —
// shared rather than restated, so a kit's purchase link and the Purchases panel
// can never disagree about which orders count.
import { expensePairPredicate } from "~/server/repo/purchase-products";
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
import type { UsdaFoodBatchPort } from "~/server/services/usda-helpers";

export interface ProductComponentEntry {
  productId: ProductId;
  quantity: number;
}

/**
 * Components of several kits at once, each shaped as a full PRODUCT LIST ROW.
 *
 * `listProductComponents` below answers "what is in this kit" for the detail
 * page, and its seven fields are all that page needs. This answers a different
 * question: the Products list renders a kit's components as ordinary rows of
 * its own table, so a component has to fill the same ~30 columns its parent
 * does — quantity ledger, expense totals, data quality, tags, the lot.
 *
 * So it deliberately reuses `productList`'s own assembly (`relations.product.list`
 * → data qualities → pricing → quantity ledger → `dbProductToListAPI`) rather
 * than widening `productComponentOut` field by field. A child row is then the
 * same shape as a parent BY CONSTRUCTION; the alternative drifts the moment
 * anyone adds a column.
 *
 * Batched over parents because the caller fetches every kit on the page at
 * once. That is not an optimization — fetching per expanded row would deliver
 * children after render, and `DesktopDataRow`'s memo compares `row.original`,
 * so the new rows would silently never paint without a `rowContentVersion`
 * bump. Having the data before rows are built avoids that class of bug.
 *
 * One product can be a component of several kits (10 are, on live data), so a
 * component appears once per parent and the caller keys child rows by the pair.
 */
export async function listKitComponentRows(
  db: Database,
  parentProductIds: ProductId[],
  usdaClient?: UsdaFoodBatchPort,
): Promise<KitComponentRowOut[]> {
  if (parentProductIds.length === 0) return [];
  const dbc = getDb(db);

  // Live edge AND live component product — the same pair of predicates the
  // `componentPresenceFilter` id-set and the `componentCount` scalar use, so
  // the count on a parent row always matches the children that appear under it.
  // The parent is joined through an alias purely to read its SHORTCODE: the
  // uuid is a repo-private detail and must never cross the API boundary, and
  // the caller keys child rows by `${parentShortcode}:${componentShortcode}`.
  const parentProduct = alias(product, "kitParentProduct");
  const edges = await dbc
    .select({
      parentProductId: parentProduct.shortcode,
      componentProductId: productComponent.componentProductId,
      quantity: productComponent.quantity,
      componentName: product.name,
    })
    .from(productComponent)
    .innerJoin(
      product,
      and(
        eq(product.id, productComponent.componentProductId),
        notDeleted(product),
      ),
    )
    .innerJoin(
      parentProduct,
      and(
        eq(parentProduct.id, productComponent.parentProductId),
        notDeleted(parentProduct),
      ),
    )
    .where(
      and(
        inArray(productComponent.parentProductId, parentProductIds),
        notDeleted(productComponent),
      ),
    )
    .orderBy(asc(product.name));

  if (edges.length === 0) return [];

  const componentIds = uniq(edges.map((edge) => edge.componentProductId));
  const rows = await dbc.query.product.findMany({
    where: and(inArray(product.id, componentIds), notDeleted(product)),
    ...relations.product.list,
  });

  const qualities = await loadDataQualities(
    db,
    "product",
    rows.map((row) => row.id),
  );
  const priced = await enrichProductRowsWithPricing(db, rows);
  const ledgered = await enrichProductRowsWithQuantityLedger(db, priced);
  const projectedItems = await withDisplayImages(
    db,
    "product",
    ledgered,
    (row, displayImages) =>
      dbProductToListAPI(
        { ...row, dataQuality: qualities.get(row.id)! },
        displayImages,
      ),
  );
  const items = await enrichProductListItems(projectedItems, usdaClient);
  // Keyed by the private uuid the edges carry, not the item's public shortcode.
  const byId = new Map(ledgered.map((row, index) => [row.id, items[index]!]));

  return edges.flatMap((edge) => {
    const item = byId.get(edge.componentProductId);
    if (!item) return [];
    return [
      {
        parentProductId: parseShortcodeFor("product", edge.parentProductId),
        quantity: edge.quantity,
        product: item,
      },
    ];
  });
}

export async function listProductComponents(
  db: Database,
  parentProductId: ProductId,
): Promise<ProductComponentOut[]> {
  const dbc = getDb(db);
  const rows = await dbc
    .select({
      productId: product.id,
      productCode: product.shortcode,
      productName: product.name,
      manufacturer: product.manufacturer,
      quantity: productComponent.quantity,
      attachedAt: productComponent.createdAt,
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
        eq(productComponent.parentProductId, parentProductId),
        notDeleted(productComponent),
      ),
    )
    .orderBy(asc(product.name));

  const componentProductIds = rows.map((row) => row.productId);
  // `loadProductPickerQuantities` rather than a stock query of our own: it
  // already owns the live-`Location` join, the identity-location union (a bin
  // in service IS a unit you hold), and the mixed-unit guard. Those three rules
  // exist in exactly one place on purpose, so a component's count here cannot
  // drift from the same product's count on the products list.
  const [prices, coverImageUrls, quantities] = await Promise.all([
    loadEffectiveProductPricesById(db, componentProductIds),
    getProductCoverImageUrlsByProductIds(db, componentProductIds),
    loadProductPickerQuantities(db, componentProductIds),
  ]);

  return rows.map((row) => {
    const onHand = quantities.get(row.productId)?.onHand;
    return {
      productId: parseShortcodeFor("product", row.productCode),
      productName: row.productName,
      manufacturer: row.manufacturer,
      quantity: row.quantity,
      price: prices.get(row.productId) ?? null,
      coverImageUrl: coverImageUrls.get(row.productId) ?? null,
      onHandUnits:
        onHand?.state === "counted"
          ? onHand.units
          : onHand?.state === "none"
            ? 0
            : null,
      attachedAt: row.attachedAt,
    };
  });
}

/**
 * Live Expense count per parent id — the kit's own cost-basis row count. A
 * component has none of its own, so this is what an empty Expense History
 * points at instead.
 */
async function loadLiveExpenseCountsByProductId(
  db: Database,
  parentProductIds: ProductId[],
): Promise<Map<ProductId, number>> {
  if (parentProductIds.length === 0) return new Map();
  const rows = await getDb(db)
    .select({ productId: expense.productId })
    .from(expense)
    .where(
      and(inArray(expense.productId, parentProductIds), notDeleted(expense)),
    );
  const counts = new Map<ProductId, number>();
  for (const row of rows) {
    if (row.productId === null) continue;
    counts.set(row.productId, (counts.get(row.productId) ?? 0) + 1);
  }
  return counts;
}

async function loadMostRecentPurchaseByProductId(
  db: Database,
  parentProductIds: ProductId[],
): Promise<Map<ProductId, KitMembershipPurchaseOut>> {
  if (parentProductIds.length === 0) return new Map();
  const dbc = getDb(db);
  const purchaseColumns = {
    purchaseCode: purchase.shortcode,
    displayLabel: purchase.displayLabel,
    date: purchase.date,
    orderId: purchase.orderId,
    vendorName: vendor.name,
  };
  const liveVendor = and(eq(vendor.id, purchase.vendorId), notDeleted(vendor));

  // Both legs, for the same reason `listProductPurchases` needs both: a kit
  // whose order is itemized per product has no `PurchaseProduct` row at all,
  // so the link-only query returned null for exactly the kits this carve-out
  // exists to link to.
  const [linkRows, expenseRows] = await Promise.all([
    dbc
      .select({ productId: purchaseProduct.productId, ...purchaseColumns })
      .from(purchaseProduct)
      .innerJoin(
        purchase,
        and(eq(purchase.id, purchaseProduct.purchaseId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(
        and(
          inArray(purchaseProduct.productId, parentProductIds),
          notDeleted(purchaseProduct),
        ),
      ),
    dbc
      .selectDistinct({ productId: expense.productId, ...purchaseColumns })
      .from(expense)
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(
        expensePairPredicate(inArray(expense.productId, parentProductIds)),
      ),
  ]);

  const rows = [...linkRows, ...expenseRows].sort((a, b) =>
    b.date.localeCompare(a.date),
  );

  const byProduct = new Map<ProductId, KitMembershipPurchaseOut>();
  for (const row of rows) {
    if (row.productId === null) continue;
    if (byProduct.has(row.productId)) continue;
    byProduct.set(row.productId, {
      purchaseId: parseShortcodeFor("purchase", row.purchaseCode),
      displayLabel: row.displayLabel,
      vendorName: row.vendorName,
      date: row.date,
      orderId: row.orderId,
    });
  }
  return byProduct;
}

export async function listKitMembership(
  db: Database,
  componentProductId: ProductId,
): Promise<KitMembershipOut[]> {
  const parent = product;
  const rows = await getDb(db)
    .select({
      parentId: parent.id,
      parentCode: parent.shortcode,
      parentName: parent.name,
      manufacturer: parent.manufacturer,
      quantity: productComponent.quantity,
      attachedAt: productComponent.createdAt,
    })
    .from(productComponent)
    .innerJoin(
      parent,
      and(eq(parent.id, productComponent.parentProductId), notDeleted(parent)),
    )
    .where(
      and(
        eq(productComponent.componentProductId, componentProductId),
        notDeleted(productComponent),
      ),
    )
    .orderBy(desc(productComponent.createdAt));

  const parentProductIds = uniq(rows.map((row) => row.parentId));
  const [prices, expenseCounts, purchases, coverImageUrls] = await Promise.all([
    loadEffectiveProductPricesById(db, parentProductIds),
    loadLiveExpenseCountsByProductId(db, parentProductIds),
    loadMostRecentPurchaseByProductId(db, parentProductIds),
    getProductCoverImageUrlsByProductIds(db, parentProductIds),
  ]);

  return rows.map((row) => ({
    parentProductId: parseShortcodeFor("product", row.parentCode),
    parentProductName: row.parentName,
    manufacturer: row.manufacturer,
    quantity: row.quantity,
    coverImageUrl: coverImageUrls.get(row.parentId) ?? null,
    attachedAt: row.attachedAt,
    price: prices.get(row.parentId) ?? null,
    expenseCount: expenseCounts.get(row.parentId) ?? 0,
    purchase: purchases.get(row.parentId) ?? null,
  }));
}

/** Every LIVE `ProductComponent` edge, for the cycle guard — it needs the
 * whole graph, not just the rows touching the attach's own parent, because a
 * kit several hops above a proposed component can close a loop the touched
 * edges alone would never reveal. */
async function allLiveComponentEdges(
  dbc: DrizzleClient | DrizzleTransaction,
): Promise<{ parentProductId: ProductId; componentProductId: ProductId }[]> {
  return dbc
    .select({
      parentProductId: productComponent.parentProductId,
      componentProductId: productComponent.componentProductId,
    })
    .from(productComponent)
    .where(notDeleted(productComponent));
}

/** Render an id path as shortcodes for an error message — a uuid must never
 * reach a client. Mirrors the same-named helper in `repo/product/merge.ts`
 * (not exported there, so duplicated rather than imported). */
async function describeComponentPath(
  dbc: DrizzleClient | DrizzleTransaction,
  path: readonly ProductId[],
): Promise<string> {
  const rows = await dbc
    .select({ id: product.id, shortcode: product.shortcode })
    .from(product)
    .where(inArray(product.id, uniq([...path])));
  const byId = new Map(rows.map((row) => [row.id, row.shortcode]));
  return path.map((id) => byId.get(id) ?? "?").join(" → ");
}

async function liveComponentShortcodes(
  dbc: DrizzleClient,
  parentProductId: ProductId,
): Promise<string[]> {
  const rows = await dbc
    .select({ shortcode: product.shortcode })
    .from(productComponent)
    .innerJoin(product, eq(product.id, productComponent.componentProductId))
    .where(
      and(
        eq(productComponent.parentProductId, parentProductId),
        notDeleted(productComponent),
        notDeleted(product),
      ),
    )
    .orderBy(asc(product.shortcode));
  return rows.map((row) => row.shortcode);
}

/**
 * Which component ids the parent already lists, live.
 *
 * Sequential single query, so it runs on a transaction client or the pooled one
 * — see the transaction-boundary note in `repo/relation-preflight.ts`.
 */
async function liveComponentIds(
  dbc: DrizzleClient | DrizzleTransaction,
  parentProductId: ProductId,
  componentProductIds: readonly ProductId[],
): Promise<Set<string>> {
  if (componentProductIds.length === 0) return new Set();
  const rows = await dbc
    .select({ componentProductId: productComponent.componentProductId })
    .from(productComponent)
    .where(
      and(
        eq(productComponent.parentProductId, parentProductId),
        inArray(productComponent.componentProductId, [...componentProductIds]),
        notDeleted(productComponent),
      ),
    );
  return new Set(rows.map((row) => row.componentProductId));
}

async function preflightAttachComponents(
  dbc: DrizzleClient | DrizzleTransaction,
  parentProductId: ProductId,
  componentProductIds: readonly ProductId[],
): Promise<RelationPreflight> {
  const requested = uniq([...componentProductIds]);
  const { rows, codeById } = await loadRelationProducts(dbc, [
    parentProductId,
    ...requested,
  ]);
  const liveIds = new Set(rows.filter((row) => row.live).map((row) => row.id));

  const parentMissing = !liveIds.has(parentProductId);
  const missing = requested.filter((id) => !liveIds.has(id));
  const selfReference = requested.filter((id) => id === parentProductId);

  if (parentMissing || missing.length > 0 || selfReference.length > 0) {
    return {
      ...emptyPreflight(),
      requested,
      parentMissing,
      missing,
      selfReference,
      codeById,
    };
  }

  // Multi-hop cycle guard: the one-hop self-reference is refused above (and
  // backstopped by the DB CHECK), but A→B→A several hops down is only visible
  // by walking the WHOLE live edge set with the proposed new edges projected on
  // top. See the `findMergeComponentCycle` import comment.
  const liveEdges = await allLiveComponentEdges(dbc);
  const cycle = findMergeComponentCycle({
    edges: [
      ...liveEdges,
      ...requested.map((productId) => ({
        parentProductId,
        componentProductId: productId,
      })),
    ],
    keepId: parentProductId,
    loserIds: [],
  });

  const alreadyLive = await liveComponentIds(dbc, parentProductId, requested);
  return {
    ...emptyPreflight(),
    requested,
    alreadySatisfied: requested.filter((id) => alreadyLive.has(id)),
    cyclePath: cycle ? await describeComponentPath(dbc, cycle) : null,
    codeById,
  };
}

/** The detach counterpart: the only thing to know is which links exist. */
async function preflightDetachComponents(
  dbc: DrizzleClient | DrizzleTransaction,
  parentProductId: ProductId,
  componentProductIds: readonly ProductId[],
): Promise<RelationPreflight> {
  const requested = uniq([...componentProductIds]);
  const { codeById } = await loadRelationProducts(dbc, [
    parentProductId,
    ...requested,
  ]);
  const alreadyLive = await liveComponentIds(dbc, parentProductId, requested);
  return {
    ...emptyPreflight(),
    requested,
    alreadySatisfied: requested.filter((id) => !alreadyLive.has(id)),
    codeById,
  };
}

/** Refuse a component attach, naming the offending shortcodes. */
function assertComponentsAttachable(
  parentProductId: ProductId,
  pre: RelationPreflight,
): void {
  if (pre.parentMissing) {
    throwRelationRefusal({
      reason: "PRODUCT_NOT_FOUND",
      ids: [parentProductId],
      codeById: pre.codeById,
      message: (codes) => `Product ${codes} not found`,
      items: [],
    });
  }
  if (pre.selfReference.length > 0) {
    throwRelationRefusal({
      reason: "PRODUCT_COMPONENT_SELF_REFERENCE",
      ids: pre.selfReference,
      codeById: pre.codeById,
      message: (codes) =>
        `A product cannot be a component of itself (${codes}).`,
      items: [
        relationImpact({
          code: "block-component-self-reference",
          label: "self-referencing components",
          description: "A Product cannot be listed inside itself.",
          ids: pre.selfReference,
        }),
      ],
    });
  }
  if (pre.missing.length > 0) {
    throwRelationRefusal({
      reason: "PRODUCT_NOT_FOUND",
      ids: pre.missing,
      codeById: pre.codeById,
      message: (codes) =>
        `Every component Product must exist and be live. Not live: ${codes}.`,
      items: [
        relationImpact({
          code: "block-component-not-live",
          label: "products that are not live",
          description:
            "A component Product named here does not exist or has been deleted.",
          ids: pre.missing,
        }),
      ],
    });
  }
  if (pre.cyclePath) {
    throwRelationRefusal({
      reason: "PRODUCT_COMPONENT_CYCLE",
      ids: [parentProductId],
      codeById: pre.codeById,
      message: () =>
        `Attaching would make a product contain itself (${pre.cyclePath}). Detach the conflicting link first.`,
      items: [
        relationImpact({
          code: "block-component-cycle",
          label: "component cycle",
          description: `Attaching would close a cycle: ${pre.cyclePath}.`,
          ids: [parentProductId],
        }),
      ],
    });
  }
}

/**
 * Advisory impact for a component attach, using the SAME predicate the
 * mutation refuses on. Runs on the pooled client, outside any transaction.
 */
export async function previewAttachProductComponents(
  db: Database,
  parentProductId: ProductId,
  componentProductIds: readonly ProductId[],
): Promise<RelationPlan> {
  const pre = await preflightAttachComponents(
    getDb(db),
    parentProductId,
    componentProductIds,
  );
  return planRelationAttach(pre, {
    edgeKey: "ProductComponent.componentProductId",
    label: "kit components",
    description: "Component links this attach would create.",
  });
}

export async function previewDetachProductComponents(
  db: Database,
  parentProductId: ProductId,
  componentProductIds: readonly ProductId[],
): Promise<RelationPlan> {
  const pre = await preflightDetachComponents(
    getDb(db),
    parentProductId,
    componentProductIds,
  );
  return planRelationDetach(pre, {
    edgeKey: "ProductComponent.componentProductId",
    label: "kit components",
    description: "Component links this detach would remove.",
  });
}

export async function attachProductComponents(
  db: Database,
  parentProductId: ProductId,
  components: ProductComponentEntry[],
  actor: ActorContext,
): Promise<RelationMutationOut> {
  const uniqueComponents = uniqBy(components, (c) => c.productId);
  const componentProductIds = uniqueComponents.map((c) => c.productId);

  return withTransaction(db, async (tx) => {
    // The preflight runs on `tx`, not the pooled client: its checks and the
    // insert below must see one snapshot, or a component soft-deleted between
    // the two lands as a live edge to a dead product.
    const pre = await preflightAttachComponents(
      tx,
      parentProductId,
      componentProductIds,
    );
    assertComponentsAttachable(parentProductId, pre);

    const before = await liveComponentShortcodes(tx, parentProductId);
    const inserted = await tx
      .insert(productComponent)
      .values(
        uniqueComponents.map(({ productId, quantity }) => ({
          parentProductId,
          componentProductId: productId,
          quantity,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: productComponent.id });
    const after = await liveComponentShortcodes(tx, parentProductId);

    if (inserted.length > 0) {
      await markProductConversionCoverageInputStale(tx, [parentProductId]);
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: parentProductId,
        action: "update",
        changes: { componentProductIds: { from: before, to: after } },
      });
    }
    // Every id in `uniqueComponents` was already confirmed live above, so the
    // only reason one wouldn't land in `inserted` is `onConflictDoNothing`
    // skipping an edge that was already there — the no-op bucket.
    return {
      changed: inserted.length,
      attached: after.length,
      alreadySatisfied: uniqueComponents.length - inserted.length,
    };
  });
}

export async function detachProductComponents(
  db: Database,
  parentProductId: ProductId,
  componentProductIds: ProductId[],
  actor: ActorContext,
): Promise<RelationMutationOut> {
  const uniqueComponentIds = uniq(componentProductIds);
  return withTransaction(db, async (tx) => {
    const before = await liveComponentShortcodes(tx, parentProductId);
    const removed = await tx
      .update(productComponent)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(productComponent.parentProductId, parentProductId),
          inArray(productComponent.componentProductId, uniqueComponentIds),
          notDeleted(productComponent),
        ),
      )
      .returning({ id: productComponent.id });
    const after = await liveComponentShortcodes(tx, parentProductId);

    if (removed.length > 0) {
      await markProductConversionCoverageInputStale(tx, [parentProductId]);
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: parentProductId,
        action: "update",
        changes: { componentProductIds: { from: before, to: after } },
      });
    }
    // Unlike attach, a requested id here was never confirmed live — it may
    // never have been attached at all. Either way (never attached, or
    // attached and already removed), the outcome is the same "no live edge",
    // so the arithmetic still holds: whatever wasn't removed was already in
    // the detached state being asked for.
    return {
      changed: removed.length,
      attached: after.length,
      alreadySatisfied: uniqueComponentIds.length - removed.length,
    };
  });
}

export const productComponentsRelationAdapter = {
  preview(db, action, ownerId, targetIds) {
    const parentProductId = parseEntityId("product", ownerId);
    const componentProductIds = targetIds.map((id) =>
      parseEntityId("product", id),
    );
    return action === "attach"
      ? previewAttachProductComponents(db, parentProductId, componentProductIds)
      : previewDetachProductComponents(
          db,
          parentProductId,
          componentProductIds,
        );
  },
  async execute(ctx, action, ownerShortcode, items) {
    const parentProductId = await resolveOrThrow(
      ctx.db,
      "product",
      ownerShortcode,
    );
    const componentProductIds = await resolveAllOrThrow(
      ctx.db,
      "product",
      items.map(({ id }) => id),
    );
    return action === "attach"
      ? attachProductComponents(
          ctx.db,
          parentProductId,
          componentProductIds.map((productId, index) => ({
            productId,
            quantity: items[index]?.quantity ?? 1,
          })),
          ctx.actorContext,
        )
      : detachProductComponents(
          ctx.db,
          parentProductId,
          componentProductIds,
          ctx.actorContext,
        );
  },
} satisfies EntityRelationMutationAdapter<{
  id: string;
  quantity?: number;
}>;
