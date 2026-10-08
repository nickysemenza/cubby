import { and, eq } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import {
  importSourceClaim,
  mailboxMessage,
  orderMail,
} from "~/server/db/schema";

import { readImportSourceClaimFamily } from "./source-claim-family";

export const HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION =
  "legacy-source-identity-unresolved/v1";

export async function mailSourceIdentityBlocked(
  db: Pick<DrizzleTransaction, "select">,
  source: Pick<
    typeof orderMail.$inferSelect,
    "id" | "ledgerPartyId" | "mailboxId" | "messageId"
  >,
) {
  const [blocked] = await db
    .select({ id: mailboxMessage.id })
    .from(mailboxMessage)
    .where(
      and(
        eq(mailboxMessage.ledgerPartyId, source.ledgerPartyId),
        eq(mailboxMessage.mailboxId, source.mailboxId),
        eq(mailboxMessage.messageId, source.messageId),
        eq(mailboxMessage.orderMailId, source.id),
        eq(
          mailboxMessage.classificationVersion,
          HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION,
        ),
      ),
    )
    .limit(1);
  return Boolean(blocked);
}

export async function assertMailSourceIdentityReady(
  db: Pick<DrizzleTransaction, "select">,
  source: Parameters<typeof mailSourceIdentityBlocked>[1],
) {
  if (await mailSourceIdentityBlocked(db, source))
    throw new Error(
      "Historical mail source ownership is unresolved; verify the original mapping before research or cleanup.",
    );
}

/** Originals and their attachments retain every historical owner in the canonical family. */
export async function loadMailSourceClaimIds(
  db: Pick<DrizzleTransaction, "select">,
  source: Pick<
    typeof orderMail.$inferSelect,
    "ledgerPartyId" | "mailboxId" | "messageId"
  >,
  attachmentIds: readonly string[] = [],
) {
  const key = `gmail:${source.mailboxId}:${source.messageId}`;
  const identities = [
    { kind: "mail_message", externalKey: key },
    ...attachmentIds.map((id) => ({
      kind: "mail_attachment",
      externalKey: `${key}:attachment:${id}`,
    })),
  ];
  const ids = new Set<typeof importSourceClaim.$inferSelect.id>();
  for (const identity of identities) {
    const family = await readImportSourceClaimFamily(db, {
      ...identity,
      ledgerPartyId: source.ledgerPartyId,
    });
    for (const claim of family?.members ?? []) ids.add(claim.id);
  }
  return [...ids];
}
