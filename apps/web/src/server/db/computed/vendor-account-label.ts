import { type SQL, sql } from "drizzle-orm";

/**
 * A VendorAccount's display label, `<Vendor> · <member>`, from the current
 * parent names; nothing is stored, so a rename can never leave it stale. The
 * live vendor/member pair is unique (`VendorAccount_vendor_member_key`).
 * includes-deleted: both FKs are required, so a tombstoned parent still
 * names the account rather than blanking it.
 */
export const vendorAccountLabelFor = (account: {
  vendorId: SQL;
  ledgerPartyId: SQL;
}) =>
  sql<string>`(SELECT label_vendor."name" || ' · ' || label_party."name" FROM "Vendor" label_vendor, "LedgerParty" label_party WHERE label_vendor."id" = ${account.vendorId} AND label_party."id" = ${account.ledgerPartyId})`;

/**
 * The label over an unaliased `"VendorAccount"` in the outer query. The
 * literal qualified columns keep the correlation on the outer row even in a
 * single-table select, where interpolated Drizzle columns render unqualified.
 */
export const vendorAccountLabelSql = vendorAccountLabelFor({
  vendorId: sql.raw(`"VendorAccount"."vendorId"`),
  ledgerPartyId: sql.raw(`"VendorAccount"."ledgerPartyId"`),
});
