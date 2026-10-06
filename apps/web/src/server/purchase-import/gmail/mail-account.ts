import type { LedgerPartyId, VendorId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { vendor, vendorAccount } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { findOrCreateWithShortcode } from "~/server/repo/shortcode-utils";

/**
 * The member's VendorAccount for a Vendor, created mail-only (disabled, no
 * browser sync) when order mail is the first evidence of the relationship. An
 * existing account — mail-only or browser-synced — is returned unchanged, so
 * this never turns browser sync on or moves a history cursor.
 */
export async function ensureMailVendorAccount(
  db: Database | DrizzleTransaction,
  input: { vendorId: VendorId; ledgerPartyId: LedgerPartyId },
) {
  const { row } = await findOrCreateWithShortcode(db, "vendorAccount", {
    where: and(
      eq(vendorAccount.vendorId, input.vendorId),
      eq(vendorAccount.ledgerPartyId, input.ledgerPartyId),
      notDeleted(vendorAccount),
    ),
    values: async () => ({
      label: `${await vendorName(db, input.vendorId)} mail`,
      vendorId: input.vendorId,
      ledgerPartyId: input.ledgerPartyId,
      status: "disabled",
      browserSyncEnabled: false,
    }),
  });
  return row;
}

async function vendorName(db: Database | DrizzleTransaction, id: VendorId) {
  const [row] = await unwrapDb(db)
    .select({ name: vendor.name })
    .from(vendor)
    .where(eq(vendor.id, id))
    .limit(1);
  if (!row) throw new Error("Vendor for this order mail no longer exists");
  return row.name;
}
