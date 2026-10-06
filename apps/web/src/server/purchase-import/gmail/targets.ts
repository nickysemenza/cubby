import type { ActorContext } from "@cubby/schemas/context";
import { and, eq, isNotNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import { ledgerParty, vendor } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { currentMemberLedgerParty } from "~/server/repo/member-login";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import type { GmailBootstrapInput } from "./types";
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
    vendorId,
    identity: identity[0],
    memberId: member.id,
    memberShortcode: member.shortcode,
    userId: actor.userId,
  };
}

export type GmailSyncTarget = {
  ledgerPartyId: string;
  userId: string;
  mailboxId: string;
  bootstrap: GmailBootstrapInput;
};

/**
 * Members whose login has connected Google: the mailboxes a scheduled
 * discovery pass reads. A member who never connected Gmail gets no pass (and
 * no failing Run) until they do.
 */
export async function listGmailSyncTargets(
  db: Database,
): Promise<GmailSyncTarget[]> {
  const [members, vendors] = await Promise.all([
    db
      .clientForRepository()
      .selectDistinct({
        ledgerPartyId: ledgerParty.id,
        userId: ledgerParty.userId,
      })
      .from(ledgerParty)
      .innerJoin(
        account,
        and(
          eq(account.userId, ledgerParty.userId),
          eq(account.providerId, "google"),
        ),
      )
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
