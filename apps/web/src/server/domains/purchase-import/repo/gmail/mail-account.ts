import type { LedgerPartyId, VendorId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import { vendorAccount } from "~/server/db/schema";
import { findOrCreateWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

/**
 * The member's VendorAccount for a Vendor, created disabled when order mail
 * is the first evidence of the relationship. Existing accounts keep their status
 * and history cursor.
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
    values: () => ({
      vendorId: input.vendorId,
      ledgerPartyId: input.ledgerPartyId,
      status: "disabled" as const,
    }),
  });
  return row;
}
