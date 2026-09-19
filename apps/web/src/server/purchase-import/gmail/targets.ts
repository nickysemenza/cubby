import { and, eq, isNotNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { ledgerParty, vendor, vendorAccount } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

import type { GmailSyncTarget } from "./hourly";

export async function listGmailSyncTargets(
  db: Database,
): Promise<GmailSyncTarget[]> {
  const rows = await db
    .clientForRepository()
    .select({
      ledgerPartyId: ledgerParty.id,
      userId: ledgerParty.userId,
      senders: vendor.orderEmailSenders,
    })
    .from(ledgerParty)
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.ledgerPartyId, ledgerParty.id),
        notDeleted(vendorAccount),
      ),
    )
    .leftJoin(
      vendor,
      and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
    )
    .where(and(isNotNull(ledgerParty.userId), notDeleted(ledgerParty)));
  const grouped = new Map<
    string,
    { ledgerPartyId: string; userId: string; senders: Set<string> }
  >();
  for (const row of rows) {
    if (!row.userId) continue;
    const current = grouped.get(row.ledgerPartyId) ?? {
      ledgerPartyId: row.ledgerPartyId,
      userId: row.userId,
      senders: new Set<string>(),
    };
    for (const sender of row.senders ?? []) current.senders.add(sender);
    grouped.set(row.ledgerPartyId, current);
  }
  return [...grouped.values()].map((row) => ({
    ledgerPartyId: row.ledgerPartyId,
    userId: row.userId,
    mailboxId: "me",
    bootstrap: { knownSenders: [...row.senders].sort() },
  }));
}
