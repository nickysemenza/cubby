import { and, count, eq, inArray } from "drizzle-orm";
import type { Database } from "~/server/db";
import { expense, purchase, vendor } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * Hydrate card aggregates for an already-selected canonical vendor page.
 * This intentionally has no logo/purchase membership predicate: callers hand
 * it the exact list IDs, and this query only supplies display counts.
 */
export const loadVendorLogoPresenterCounts = async (
  db: Database,
  shortcodes: readonly string[],
): Promise<Map<string, { expenseRowCount: number }>> => {
  if (shortcodes.length === 0) return new Map();
  const rows = await getDb(db)
    .select({ shortcode: vendor.shortcode, expenseRowCount: count(expense.id) })
    .from(vendor)
    .leftJoin(
      purchase,
      and(eq(purchase.vendorId, vendor.id), notDeleted(purchase)),
    )
    .leftJoin(
      expense,
      and(eq(expense.purchaseId, purchase.id), notDeleted(expense)),
    )
    .where(and(notDeleted(vendor), inArray(vendor.shortcode, [...shortcodes])))
    .groupBy(vendor.id);
  return new Map(
    rows.map((row) => [
      row.shortcode,
      { expenseRowCount: Number(row.expenseRowCount) },
    ]),
  );
};
