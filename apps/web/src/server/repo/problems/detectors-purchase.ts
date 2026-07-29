/**
 * Purchase-centric Problems detectors.
 *
 * Guardrail for the `(vendor, orderId)` group key. "The rest of this order" —
 * the Same Order detail section and the `?order=…&vendor=…` ledger scope — is
 * resolved by matching BOTH columns, which is the right rule (a short id like
 * Tool Nirvana's "#11325" must not collide with another retailer's) but fails
 * silently when an order's own rows disagree about the vendor: the order splits
 * in two and each half looks whole. This detector surfaces exactly that state.
 */

import type { PurchaseId } from "@cubby/schemas/identifiers";
import type { OrderWithPartialVendor } from "@cubby/schemas/problems";
import { sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { purchase } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

/**
 * Orders where some rows carry a vendor and some don't.
 *
 * Both `bool_or`s are load-bearing, and neither is redundant: an order that is
 * entirely vendorless is a coherent group (it resolves via
 * `vendorPresenceFilter: "none"` and finds all its own rows), not drift, so
 * only the *mixed* case is a problem. Single-row orders can't be mixed and
 * fall out of the HAVING on their own.
 *
 * `array_agg(DISTINCT vendor)` over a filtered set rather than
 * `array_remove(..., NULL)`: the FILTER clause keeps the null out of the
 * aggregate entirely, so an all-null group yields NULL (coalesced) rather than
 * an array with a hole in it.
 *
 * Pure SQL, single grouped scan over one table — safe on the Problems fast
 * path, and served by `Purchase_orderId_vendor_idx`.
 */
export const findOrdersWithPartialVendor = async (
  db: Database,
): Promise<OrderWithPartialVendor[]> => {
  const res = await getDb(db).execute<OrderWithPartialVendor>(sql`
    SELECT
      p."orderId" AS "orderId",
      COALESCE(
        array_agg(DISTINCT p."vendor") FILTER (WHERE p."vendor" IS NOT NULL),
        '{}'
      ) AS "vendors",
      count(*)::int AS "rowCount",
      count(*) FILTER (WHERE p."vendor" IS NULL)::int AS "missingCount",
      array_agg(p.id) FILTER (WHERE p."vendor" IS NULL) AS "purchaseIds"
    FROM ${purchase} p
    WHERE p."deletedAt" IS NULL AND p."orderId" IS NOT NULL
    GROUP BY p."orderId"
    HAVING bool_or(p."vendor" IS NULL) AND bool_or(p."vendor" IS NOT NULL)
    ORDER BY count(*) DESC, p."orderId" ASC
  `);
  return res.rows;
};

/**
 * The single vendor an order's populated rows agree on, plus the rows missing
 * it — the input a backfill needs, re-derived server-side.
 *
 * Returns null when the order doesn't exist, is already consistent, or has more
 * than one distinct vendor. That last case is why this exists rather than the
 * caller passing a vendor in: an order split across two real retailers has no
 * correct answer, and re-deriving here means a stale client can't write one.
 */
export const resolveOrderVendorBackfill = async (
  db: Database,
  orderId: string,
): Promise<{ vendor: string; purchaseIds: PurchaseId[] } | null> => {
  const orders = await findOrdersWithPartialVendor(db);
  const match = orders.find((order) => order.orderId === orderId);
  const vendor = match?.vendors.length === 1 ? match.vendors[0] : undefined;
  if (!match || !vendor) return null;
  return { vendor, purchaseIds: match.purchaseIds };
};
