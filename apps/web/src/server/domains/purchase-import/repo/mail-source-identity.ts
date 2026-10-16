import { and, eq } from "drizzle-orm";

import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { email as emailTable } from "~/server/db/retained-tables";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";

export const HISTORICAL_MAIL_SOURCE_IDENTITY_VERSION =
  "legacy-source-identity-unresolved/v1";

export async function mailSourceIdentityBlocked(
  db: Pick<DrizzleTransaction, "select">,
  source: Pick<
    RetainedMail,
    "id" | "ledgerPartyId" | "mailboxId" | "messageId"
  >,
) {
  const [blocked] = await db
    .select({ id: emailTable.id })
    .from(emailTable)
    .where(
      and(
        eq(emailTable.ledgerPartyId, source.ledgerPartyId),
        eq(emailTable.mailboxId, source.mailboxId),
        eq(emailTable.messageId, source.messageId),
        eq(emailTable.orderMailId, source.id),
        eq(
          emailTable.classificationVersion,
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
