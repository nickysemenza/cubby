import { and, isNotNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { ledgerParty, vendor } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

import type { GmailSyncTarget } from "./hourly";

export async function listGmailSyncTargets(
  db: Database,
): Promise<GmailSyncTarget[]> {
  const [members, vendors] = await Promise.all([
    db
      .clientForRepository()
      .select({ ledgerPartyId: ledgerParty.id, userId: ledgerParty.userId })
      .from(ledgerParty)
      .where(and(isNotNull(ledgerParty.userId), notDeleted(ledgerParty))),
    db
      .clientForRepository()
      .select({ senders: vendor.orderEmailSenders })
      .from(vendor)
      .where(notDeleted(vendor)),
  ]);
  const knownSenders = [
    ...new Set(vendors.flatMap((row) => row.senders ?? [])),
  ].sort();
  return members.flatMap((row) =>
    row.userId
      ? [
          {
            ledgerPartyId: row.ledgerPartyId,
            userId: row.userId,
            mailboxId: "me",
            bootstrap: { knownSenders },
          },
        ]
      : [],
  );
}
