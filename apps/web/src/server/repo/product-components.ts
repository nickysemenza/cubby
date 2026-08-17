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

import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId } from "@cubby/schemas/identifiers";
import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import type {
  KitMembershipOut,
  ProductComponentOut,
} from "@cubby/schemas/product-components";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { uniq, uniqBy } from "es-toolkit";
import type { Database, DrizzleClient } from "~/server/db";
import { product, productComponent } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { getProductImagesByProductIds } from "~/server/repo/product";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";

/** One entry to attach: which Product, and how many of it the kit contains. */
export interface ProductComponentEntry {
  productId: ProductId;
  quantity: number;
}

/** A kit's own component list, alphabetically by name. */
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
  const [prices, imagesByProduct] = await Promise.all([
    loadEffectiveProductPricesById(db, componentProductIds),
    getProductImagesByProductIds(db, componentProductIds),
  ]);

  return rows.map((row) => ({
    productId: unsafeProductShortcode(row.productCode),
    productName: row.productName,
    manufacturer: row.manufacturer,
    quantity: row.quantity,
    price: prices.get(row.productId) ?? null,
    coverImageUrl: imagesByProduct[row.productId]?.[0]?.url ?? null,
    attachedAt: row.attachedAt,
  }));
}

/** The transpose: every kit one Product is listed inside, most recent first. */
export async function listKitMembership(
  db: Database,
  componentProductId: ProductId,
): Promise<KitMembershipOut[]> {
  const parent = product;
  const rows = await getDb(db)
    .select({
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

  return rows.map((row) => ({
    parentProductId: unsafeProductShortcode(row.parentCode),
    parentProductName: row.parentName,
    manufacturer: row.manufacturer,
    quantity: row.quantity,
    attachedAt: row.attachedAt,
  }));
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

export async function attachProductComponents(
  db: Database,
  parentProductId: ProductId,
  components: ProductComponentEntry[],
  actor: ActorContext,
): Promise<{ changed: number; attached: number }> {
  const uniqueComponents = uniqBy(components, (c) => c.productId);
  const componentProductIds = uniqueComponents.map((c) => c.productId);

  return withTransaction(db, async (tx) => {
    const liveParent = await tx.query.product.findFirst({
      where: and(eq(product.id, parentProductId), notDeleted(product)),
      columns: { id: true },
    });
    if (!liveParent) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        `Product ${parentProductId} not found`,
      );
    }

    if (componentProductIds.includes(parentProductId)) {
      throw createAppError(
        "PRODUCT_COMPONENT_SELF_REFERENCE",
        "A product cannot be a component of itself.",
      );
    }

    const liveComponents = await tx.query.product.findMany({
      where: and(inArray(product.id, componentProductIds), notDeleted(product)),
      columns: { id: true },
    });
    if (liveComponents.length !== componentProductIds.length) {
      throw createAppError(
        "PRODUCT_NOT_FOUND",
        "Every component Product must exist and be live.",
      );
    }

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
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: parentProductId,
        action: "update",
        changes: { componentProductIds: { from: before, to: after } },
      });
    }
    return { changed: inserted.length, attached: after.length };
  });
}

export async function detachProductComponents(
  db: Database,
  parentProductId: ProductId,
  componentProductIds: ProductId[],
  actor: ActorContext,
): Promise<{ changed: number; attached: number }> {
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
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: parentProductId,
        action: "update",
        changes: { componentProductIds: { from: before, to: after } },
      });
    }
    return { changed: removed.length, attached: after.length };
  });
}
