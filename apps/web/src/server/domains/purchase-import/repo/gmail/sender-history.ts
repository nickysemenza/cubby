import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { email } from "~/server/db/retained-tables";
import { emailLinkedSql } from "~/server/domains/email/repo/email-sql";

/** Outcomes for one exact sender address: Emails seen and Emails that became an accepted source or accepted link. */
export type SenderHistory = { emailsSeen: number; acceptedAsSource: number };

// Textually equal to "Email_sender_address_idx" so the lookup reads that index.
const normalizedSender = sql`lower(trim(coalesce(substring(${email.sender} from '<([^>]+)>'), ${email.sender})))`;

/** Counts accepted outcomes, never past model verdicts, so a wrong verdict cannot reinforce itself. */
export async function readSenderHistory(
  db: Database,
  input: { ledgerPartyId: string; address: string },
): Promise<SenderHistory> {
  const [row] = await unwrapDb(db)
    .select({
      emailsSeen: sql<number>`count(*)::int`,
      acceptedAsSource: sql<number>`(count(*) FILTER (WHERE ${emailLinkedSql()}))::int`,
    })
    .from(email)
    .where(
      and(
        notDeleted(email),
        eq(
          email.ledgerPartyId,
          parseEntityId("ledgerParty", input.ledgerPartyId),
        ),
        sql`${normalizedSender} = ${input.address}`,
      ),
    );
  return {
    emailsSeen: row?.emailsSeen ?? 0,
    acceptedAsSource: row?.acceptedAsSource ?? 0,
  };
}
