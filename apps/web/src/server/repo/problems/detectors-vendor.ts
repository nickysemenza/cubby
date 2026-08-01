import { unsafeVendorShortcode } from "@cubby/schemas/identifiers";
import type { VendorWithoutLogo } from "@cubby/schemas/problems";
import { and, count, countDistinct, eq } from "drizzle-orm";
import { VENDOR_LOGO_BY_SHORTCODE } from "~/lib/vendor-logos.generated";
import type { Database } from "~/server/db";
import { expense, purchase, vendor } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * Active vendors whose mini logo has not been seeded yet. The generated
 * manifest is authoritative: checking R2 per row would turn a cheap Problems
 * scan into external fan-out. Vendors with no purchases are omitted because
 * their mark is not appearing in either ledger.
 */
export const findVendorsWithoutLogos = async (
  db: Database,
): Promise<VendorWithoutLogo[]> => {
  const rows = await getDb(db)
    .select({
      shortcode: vendor.shortcode,
      name: vendor.name,
      website: vendor.website,
      purchaseCount: countDistinct(purchase.id),
      expenseRowCount: count(expense.id),
    })
    .from(vendor)
    .innerJoin(
      purchase,
      and(eq(purchase.vendorId, vendor.id), notDeleted(purchase)),
    )
    .leftJoin(
      expense,
      and(eq(expense.purchaseId, purchase.id), notDeleted(expense)),
    )
    .where(notDeleted(vendor))
    .groupBy(vendor.id);

  return rows
    .filter((row) => VENDOR_LOGO_BY_SHORTCODE[row.shortcode] === undefined)
    .map((row) => ({
      id: unsafeVendorShortcode(row.shortcode),
      name: row.name,
      website: row.website,
      purchaseCount: Number(row.purchaseCount),
      expenseRowCount: Number(row.expenseRowCount),
    }))
    .sort(
      (a, b) =>
        b.expenseRowCount - a.expenseRowCount ||
        b.purchaseCount - a.purchaseCount ||
        a.name.localeCompare(b.name),
    );
};
