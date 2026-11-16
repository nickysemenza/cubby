import type { VendorId } from "@cubby/schemas/identifiers";
import { and, asc, eq, sql, type SQLWrapper } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { textArrayParam, uuidArrayParam } from "~/server/db/helpers/query";
import { expense, purchase } from "~/server/db/schema";
import {
  ID_LABEL,
  HASH_LABEL,
  normalizeOrderKey,
} from "~/server/domains/purchase-import/policy/order-identity";
export {
  canonicalOrderId,
  normalizeOrderKey,
} from "~/server/domains/purchase-import/policy/order-identity";

/** `normalizeOrderKey` for a stored order id column. */
export const normalizedOrderIdSql = (column: SQLWrapper) =>
  sql<string>`upper(btrim(regexp_replace(btrim(regexp_replace(regexp_replace(${column}, ${ID_LABEL}, '', 'i'), ${HASH_LABEL}, '', 'i')), '^#+', '')))`;

/** Stored order ids matching any of `orderIds` after `normalizeOrderKey`. */
export const vendorOrderIdsSql = (
  column: SQLWrapper,
  orderIds: readonly string[],
) =>
  sql<boolean>`${normalizedOrderIdSql(column)} = ANY(${textArrayParam(
    orderIds.map(normalizeOrderKey),
  )})`;

export type VendorOrderOwner =
  | { kind: "none" }
  | { kind: "one"; purchase: typeof purchase.$inferSelect }
  | { kind: "ambiguous"; purchases: (typeof purchase.$inferSelect)[] };

/**
 * The live Purchases of one Vendor that own an order id, compared as
 * `normalizeOrderKey` compares it, so case, label and whitespace variants and
 * stored duplicates are all found. Callers refuse `ambiguous` (ADR 0012);
 * none picks an arbitrary first match.
 */
export async function findVendorOrderOwner(
  db: Database | DrizzleTransaction,
  input: { vendorId: VendorId; orderId: string },
  options: { lock?: "update" | "share" } = {},
): Promise<VendorOrderOwner> {
  const query = unwrapDb(db)
    .select()
    .from(purchase)
    .where(
      and(
        eq(purchase.vendorId, input.vendorId),
        vendorOrderIdsSql(purchase.orderId, [input.orderId]),
        notDeleted(purchase),
      ),
    )
    .orderBy(asc(purchase.id));
  const purchases = await (options.lock ? query.for(options.lock) : query);
  const [first, ...rest] = purchases;
  if (!first) return { kind: "none" };
  return rest.length
    ? { kind: "ambiguous", purchases }
    : { kind: "one", purchase: first };
}

export const vendorOrderOwners = (owner: VendorOrderOwner) =>
  owner.kind === "none"
    ? []
    : owner.kind === "one"
      ? [owner.purchase]
      : owner.purchases;

/**
 * The writer's target for an order id. Several owners resolve only to the
 * reviewed `targetPurchaseId`, and only while no other owner holds lines;
 * prepare and commit share this refusal.
 */
export async function reviewedVendorOrderOwner(
  db: Database | DrizzleTransaction,
  input: { vendorId: VendorId; orderId: string | null },
  targetPurchaseId: string | null | undefined,
) {
  if (!input.orderId) return undefined;
  const owner = await findVendorOrderOwner(db, {
    vendorId: input.vendorId,
    orderId: input.orderId,
  });
  if (owner.kind !== "ambiguous") return vendorOrderOwners(owner)[0];
  const reviewed = owner.purchases.find((row) => row.id === targetPurchaseId);
  if (reviewed) {
    const others = owner.purchases.flatMap((row) =>
      row.id === reviewed.id ? [] : [row.id],
    );
    const [lined] = await unwrapDb(db)
      .select({ id: expense.id })
      .from(expense)
      .where(
        and(
          sql`${expense.purchaseId} = ANY(${uuidArrayParam(others)})`,
          notDeleted(expense),
        ),
      )
      .limit(1);
    if (!lined) return reviewed;
  }
  throw new Error(
    `Several Purchases of this Vendor carry this order id (${owner.purchases.map((row) => row.shortcode).join(", ")}). Name one as targetPurchaseId, or converge them with purchase_import.converge_duplicate_source_order.`,
  );
}
