import type { VendorAccountId, VendorId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, ne } from "drizzle-orm";

import type { Database } from "~/server/db";
import { vendorAccount } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

type BrowsingAccount = {
  id: VendorAccountId;
  vendorId: VendorId;
  ledgerPartyId: typeof vendorAccount.$inferSelect.ledgerPartyId;
};

/**
 * The accounts a Mac browser may work for these Vendors: browser sync on,
 * not disabled, not deleted.
 */
export async function browsingAccounts(
  db: Database,
  vendorIds: readonly VendorId[],
): Promise<BrowsingAccount[]> {
  if (vendorIds.length === 0) return [];
  return getDb(db)
    .select({
      id: vendorAccount.id,
      vendorId: vendorAccount.vendorId,
      ledgerPartyId: vendorAccount.ledgerPartyId,
    })
    .from(vendorAccount)
    .where(
      and(
        inArray(vendorAccount.vendorId, [...new Set(vendorIds)]),
        eq(vendorAccount.browserSyncEnabled, true),
        ne(vendorAccount.status, "disabled"),
        notDeleted(vendorAccount),
      ),
    );
}

/**
 * The browsing account that works a Purchase's Products: its own account
 * when that one browses, otherwise the Vendor's only browsing account. A
 * mail Purchase imported before mail Purchases were linked to an account
 * carries none, and an account that turned browser sync on later is the
 * same relationship. Two browsing accounts for one Vendor is ambiguous, so
 * neither is chosen.
 */
export function browsingAccountFor(
  accounts: readonly BrowsingAccount[],
  purchase: { vendorId: VendorId; vendorAccountId: string | null },
): BrowsingAccount | null {
  const own = accounts.find((row) => row.id === purchase.vendorAccountId);
  if (own) return own;
  const vendorAccounts = accounts.filter(
    (row) => row.vendorId === purchase.vendorId,
  );
  return vendorAccounts.length === 1 ? vendorAccounts[0]! : null;
}
