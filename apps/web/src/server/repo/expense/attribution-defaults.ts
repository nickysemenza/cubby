import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { VendorAttributionDefaultsOut } from "@cubby/schemas/inventory-ownership";
import { and, desc, eq, exists } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  expense,
  expenseAttribution,
  ledgerParty,
  purchase,
  vendor,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * Expense has no vendor column: the vendor is reached through
 * Expense.purchaseId -> Purchase.vendorId, matched by exact name the same way
 * `findOrCreateVendor` resolves the editor's free-text vendor. Only an expense
 * with live attribution rows counts, so a newer unattributed charge never
 * blanks the default.
 */
export async function loadVendorAttributionDefaults(
  db: Database,
  vendorName: string,
): Promise<VendorAttributionDefaultsOut> {
  const empty = { beneficiaries: [], funders: [] };
  const name = vendorName.trim();
  if (!name) return empty;

  const client = getDb(db);
  const [latest] = await client
    .select({ id: expense.id })
    .from(expense)
    .innerJoin(purchase, eq(purchase.id, expense.purchaseId))
    .innerJoin(vendor, eq(vendor.id, purchase.vendorId))
    .where(
      and(
        eq(vendor.name, name),
        notDeleted(vendor),
        notDeleted(purchase),
        notDeleted(expense),
        exists(
          client
            .select({ one: expenseAttribution.id })
            .from(expenseAttribution)
            .where(
              and(
                eq(expenseAttribution.expenseId, expense.id),
                notDeleted(expenseAttribution),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(expense.date), desc(expense.createdAt))
    .limit(1);
  if (!latest) return empty;

  const rows = await client
    .select({
      role: expenseAttribution.role,
      weight: expenseAttribution.weight,
      partyShortcode: ledgerParty.shortcode,
      partyDeletedAt: ledgerParty.deletedAt,
    })
    .from(expenseAttribution)
    .leftJoin(ledgerParty, eq(ledgerParty.id, expenseAttribution.ledgerPartyId))
    .where(
      and(
        eq(expenseAttribution.expenseId, latest.id),
        notDeleted(expenseAttribution),
      ),
    );

  const result: VendorAttributionDefaultsOut = {
    beneficiaries: [],
    funders: [],
  };
  for (const row of rows) {
    if (row.partyDeletedAt) continue;
    const share = {
      partyId: row.partyShortcode
        ? parseShortcodeFor("ledgerParty", row.partyShortcode)
        : null,
      weight: row.weight,
    };
    (row.role === "beneficiary" ? result.beneficiaries : result.funders).push(
      share,
    );
  }
  return result;
}
