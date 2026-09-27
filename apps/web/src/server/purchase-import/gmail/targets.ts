import type { ActorContext } from "@cubby/schemas/context";
import { and, eq, isNotNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { ledgerParty, vendor } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { currentMemberLedgerParty } from "~/server/repo/member-login";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import type { GmailSyncTarget } from "./hourly";
import { vendorSearchTerms } from "./vendor-identity";

export async function resolveVendorMailSearchTarget(
  db: Database,
  vendorShortcode: string,
  actor: ActorContext,
) {
  const vendorId = await resolveOrThrow(db, "vendor", vendorShortcode);
  const [identity, member] = await Promise.all([
    getDb(db)
      .select({
        website: vendor.website,
        orderEmailSenders: vendor.orderEmailSenders,
      })
      .from(vendor)
      .where(and(eq(vendor.id, vendorId), notDeleted(vendor)))
      .limit(1),
    currentMemberLedgerParty(db, actor),
  ]);
  if (!identity[0]) throw new Error("Vendor is unavailable.");
  if (!member)
    throw new Error("Link your login to a member before searching Gmail.");
  return {
    identity: identity[0],
    memberId: member.id,
    memberShortcode: member.shortcode,
    userId: actor.userId,
  };
}

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
      .select({
        website: vendor.website,
        orderEmailSenders: vendor.orderEmailSenders,
      })
      .from(vendor)
      .where(notDeleted(vendor)),
  ]);
  const knownSenders = [...new Set(vendors.flatMap(vendorSearchTerms))].sort();
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
