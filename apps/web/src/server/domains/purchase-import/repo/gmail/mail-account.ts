import type { LedgerPartyId, VendorId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import { vendorAccount } from "~/server/db/schema";
import { findOrCreateWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

/**
 * Retained purchase evidence establishes a member's vendor relationship,
 * independently of login access or execution authority. Existing cursors survive.
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
    }),
  });
  return row;
}
