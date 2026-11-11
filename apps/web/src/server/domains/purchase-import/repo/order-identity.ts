import type { VendorId } from "@cubby/schemas/identifiers";
import { and, asc, eq, sql, type SQLWrapper } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import { textArrayParam } from "~/server/db/helpers/requested";
import { expense, purchase } from "~/server/db/schema";

// A printed field label before the identifier: `Trip ID: X`, `Order number: X`,
// `Confirmation No.: X` or `Order #X`. Only a label ending in an id/number word
// followed by `:`/`#`, or words followed by `#`, is removed, so `No. X` and
// identifiers that merely contain letters (`INV-123`, `ID-9`) are unchanged.
const LABEL_WORDS = String.raw`(?:[A-Za-z][A-Za-z.]*\s+){0,3}`;
const ID_LABEL = String.raw`^\s*${LABEL_WORDS}(?:id|no\.?|number|num)\s*[:#]\s*`;
const HASH_LABEL = String.raw`^\s*(?:[A-Za-z][A-Za-z.]*\s+){1,3}#\s*`;
const ID_LABEL_RE = new RegExp(ID_LABEL, "iu");
const HASH_LABEL_RE = new RegExp(HASH_LABEL, "iu");

/**
 * The order identifier a source printed, without its field label. Extraction
 * keeps what the page shows, so one vendor's order can arrive as `Trip ID: X`
 * in one Email and `X` in another; Purchases store this canonical form.
 */
export const canonicalOrderId = (value: string | null): string | null => {
  if (value === null) return null;
  const stripped = value
    .replace(ID_LABEL_RE, "")
    .replace(HASH_LABEL_RE, "")
    .trim();
  return stripped.length > 0 ? stripped : value.trim();
};

/**
 * An order number as keys and Purchase lookups compare it: label removed,
 * trimmed, leading `#` removed, upper-cased. Hyphens and suffixes stay, so an
 * Amazon `NNN-NNNNNNN-NNNNNNN` id or a split-shipment `-2` remains its own key.
 */
export const normalizeOrderKey = (value: string) =>
  (canonicalOrderId(value) ?? value)
    .trim()
    .replace(/^#+/u, "")
    .trim()
    .toUpperCase();

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
