import type { EmailCandidateSource } from "@cubby/schemas/email-candidates";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, isNull } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { email as emailTable, orderMail } from "~/server/db/retained-tables";
import { retainedMailJoin } from "~/server/domains/mail/repo/retained-mail";

/** Exact member, provider identity and retained bytes own this read-only evidence. */
export async function loadCandidateSource(
  db: Database,
  input: { emailId: string; ledgerPartyId: string },
): Promise<EmailCandidateSource> {
  const [row] = await getDb(db)
    .select({ email: emailTable, original: orderMail })
    .from(emailTable)
    .innerJoin(orderMail, retainedMailJoin)
    .where(
      and(
        eq(emailTable.id, parseEntityId("email", input.emailId)),
        eq(
          emailTable.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        eq(emailTable.provider, "gmail"),
        eq(emailTable.classification, "related"),
        isNull(emailTable.contentClearedAt),
        notDeleted(emailTable),
      ),
    )
    .limit(1);
  if (!row)
    throw new Error(
      "Email candidate original is unavailable or outside its owner",
    );
  return {
    sourceKey: `${row.email.provider}:${row.email.mailboxId}:${row.email.messageId}`,
    checksum: row.email.checksum,
    content:
      row.original.content.bodyHtml ?? row.original.content.bodyText ?? "",
  };
}

/** The candidate Email under its exact owner, regardless of retention. */
export async function readCandidateOwnerEmail(
  db: Database,
  input: { emailId: string; ledgerPartyId: string },
) {
  const [email] = await getDb(db)
    .select()
    .from(emailTable)
    .where(
      and(
        eq(emailTable.id, parseEntityId("email", input.emailId)),
        eq(
          emailTable.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
      ),
    )
    .limit(1);
  return email;
}
