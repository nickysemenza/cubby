/**
 * The owner evidence for mail attribution: the Email's owner LedgerParty with
 * its linked sign-in address and its connected Gmail profile addresses, plus
 * the household's other live members and their sign-in addresses.
 */
import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import * as Sentry from "@sentry/tanstackstart-react";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { scrubbedError } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import { account, user } from "~/server/db/auth.schema";
import { getDb, notDeleted } from "~/server/db/helpers";
import { ledgerParty } from "~/server/db/schema";
import type { MailOwnerContext } from "~/server/domains/purchase-import/service/mail-owner";

import { gmailOAuthConfigured, gmailProviderForUser } from "./gmail/provider";

// A Google account's address never changes under its id; a failed read is
// not cached so the next judgment retries it.
const profileAddresses = new Map<string, string>();

type ProfileRead = { address: string } | { warning: string };

/** A connected mailbox's own address, or why it could not be read. */
const readGmailProfileAddress = async (
  db: Database,
  { userId, mailboxId }: { userId: string; mailboxId: string },
): Promise<ProfileRead> => {
  const cached = profileAddresses.get(mailboxId);
  if (cached) return { address: cached };
  const unread = (reason: string): ProfileRead => ({
    warning: `Gmail profile address for mailbox ${mailboxId} unavailable (${reason}); owner addresses fall back to the sign-in email`,
  });
  if (!gmailOAuthConfigured()) return unread("Google OAuth is not configured");
  try {
    const provider = await gmailProviderForUser(db, userId, mailboxId);
    const address = (await provider.getProfile()).emailAddress?.trim();
    if (!address) return unread("the profile has no emailAddress");
    profileAddresses.set(mailboxId, address);
    return { address };
  } catch (error) {
    // Attribution proceeds on the sign-in address; the failure stays visible.
    // Upstream bodies can carry tokens, so only the scrubbed copy leaves.
    const captured = scrubbedError(error);
    Sentry.captureException(captured);
    return unread(captured.message);
  }
};

export async function readMailOwnerEvidence(
  db: Database,
  input: { ledgerPartyId: LedgerPartyId; mailboxIds: readonly string[] },
): Promise<MailOwnerContext> {
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
  if (!owner) return { evidence: null, warnings: [] };
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
  const profiles = await Promise.all(
    mailboxes.map((mailbox) => readGmailProfileAddress(db, mailbox)),
  );
  return {
    evidence: {
      owner: {
        name: owner.name,
        addresses: [
          ...(owner.email ? [owner.email] : []),
          ...profiles.flatMap((read) =>
            "address" in read ? [read.address] : [],
          ),
        ],
      },
      householdMembers: parties
        .filter((party) => party.id !== owner.id && party.kind === "member")
        .map((party) => ({
          name: party.name,
          addresses: party.email ? [party.email] : [],
        })),
    },
    warnings: profiles.flatMap((read) =>
      "warning" in read ? [read.warning] : [],
    ),
  };
}
