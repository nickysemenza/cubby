import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty, vendor } from "~/server/db/schema";

export async function accountProviderVendors(db: Database) {
  const rows = await getDb(db)
    .select({ id: vendor.shortcode, name: vendor.name })
    .from(vendor)
    .where(and(notDeleted(vendor), isNull(vendor.systemKey)))
    .orderBy(asc(vendor.name), asc(vendor.shortcode));
  return rows.map((row) => ({
    ...row,
    id: parseShortcodeFor("vendor", row.id),
  }));
}

export async function cardholderSuggestionMembers(db: Database) {
  const rows = await getDb(db)
    .select({ id: ledgerParty.shortcode, name: ledgerParty.name })
    .from(ledgerParty)
    .where(and(notDeleted(ledgerParty), eq(ledgerParty.kind, "member")))
    .orderBy(asc(ledgerParty.name), asc(ledgerParty.shortcode));
  return rows.map((row) => ({
    ...row,
    id: parseShortcodeFor("ledgerParty", row.id),
  }));
}
