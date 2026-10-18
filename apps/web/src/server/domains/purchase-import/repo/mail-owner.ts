/**
 * The owner evidence for mail attribution: the Email's owner LedgerParty with
 * its linked sign-in address and its connected Gmail profile addresses, plus
 * the household's other live members and their sign-in addresses.
 */
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { account, user } from "~/server/db/auth.schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty } from "~/server/db/schema";
import type { MailOwnerEvidence } from "~/server/domains/purchase-import/service/mail-owner";

import { gmailOAuthConfigured, gmailProviderForUser } from "./gmail/provider";

// A Google account's address never changes under its id; a failed read is
// not cached so the next judgment retries it.
const profileAddresses = new Map<string, string>();

/** A connected mailbox's own address, or null when it cannot be read. */
const gmailProfileAddressFor =
  (db: Database) =>
  async ({
    userId,
    mailboxId,
  }: {
    userId: string;
    mailboxId: string;
  }): Promise<string | null> => {
    const cached = profileAddresses.get(mailboxId);
    if (cached) return cached;
    if (!gmailOAuthConfigured()) return null;
    try {
      const provider = await gmailProviderForUser(db, userId, mailboxId);
      const address = (await provider.getProfile()).emailAddress?.trim();
      if (!address) return null;
      profileAddresses.set(mailboxId, address);
      return address;
    } catch {
      // A revoked or offline connection still leaves the sign-in address.
      return null;
    }
  };

export async function readMailOwnerEvidence(
  db: Database,
  input: { ledgerPartyId: LedgerPartyId; mailboxIds: readonly string[] },
): Promise<MailOwnerEvidence | null> {
  const database = getDb(db);
  const parties = await database
    .select({
      id: ledgerParty.id,
      name: ledgerParty.name,
      kind: ledgerParty.kind,
      userId: ledgerParty.userId,
      email: user.email,
    })
    .from(ledgerParty)
    .leftJoin(user, eq(user.id, ledgerParty.userId))
    .where(notDeleted(ledgerParty));
  const owner = parties.find((party) => party.id === input.ledgerPartyId);
  if (!owner) return null;
  const mailboxes =
    owner.userId && input.mailboxIds.length
      ? await database
          .select({ mailboxId: account.accountId, userId: account.userId })
          .from(account)
          .where(
            and(
              eq(account.userId, owner.userId),
              eq(account.providerId, "google"),
              isNotNull(account.refreshToken),
              inArray(account.accountId, [...new Set(input.mailboxIds)]),
            ),
          )
      : [];
  const read = gmailProfileAddressFor(db);
  const profile = await Promise.all(mailboxes.map((mailbox) => read(mailbox)));
  return {
    owner: {
      name: owner.name,
      addresses: [owner.email, ...profile].filter(
        (address): address is string => Boolean(address),
      ),
    },
    householdMembers: parties
      .filter((party) => party.id !== owner.id && party.kind === "member")
      .map((party) => ({
        name: party.name,
        addresses: party.email ? [party.email] : [],
      })),
  };
}
