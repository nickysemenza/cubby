import type { LedgerPartyId } from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import { email as emailTable, orderMail } from "~/server/db/retained-tables";

/** The original owns content; Email alone owns provider identity and headers. */
export const retainedMailProjection = {
  id: orderMail.id,
  ledgerPartyId: orderMail.ledgerPartyId,
  vendorId: orderMail.vendorId,
  rawChecksum: orderMail.rawChecksum,
  classifiedChecksum: orderMail.classifiedChecksum,
  content: orderMail.content,
  createdAt: orderMail.createdAt,
  updatedAt: orderMail.updatedAt,
  mailboxId: emailTable.mailboxId,
  messageId: emailTable.messageId,
  threadId: emailTable.threadId,
  historyId: emailTable.historyId,
  sender: emailTable.sender,
  subject: emailTable.subject,
  receivedAt: emailTable.receivedAt,
};

/** A stale or foreign content pointer cannot borrow the Email's ownership. */
export const retainedMailJoin = and(
  eq(orderMail.id, emailTable.orderMailId),
  eq(orderMail.ledgerPartyId, emailTable.ledgerPartyId),
);

export async function readRetainedMail(
  db: Database | DrizzleTransaction,
  input: {
    ledgerPartyIds: readonly LedgerPartyId[];
    mailboxId?: string;
    messageId?: string;
    orderMailIds?: readonly string[];
  },
  lock?: "update" | "share",
) {
  const query = unwrapDb(db)
    .select(retainedMailProjection)
    .from(orderMail)
    .innerJoin(emailTable, retainedMailJoin)
    .where(
      and(
        inArray(emailTable.ledgerPartyId, [...input.ledgerPartyIds]),
        eq(emailTable.provider, "gmail"),
        notDeleted(emailTable),
        input.mailboxId === undefined
          ? undefined
          : eq(emailTable.mailboxId, input.mailboxId),
        input.messageId === undefined
          ? undefined
          : eq(emailTable.messageId, input.messageId),
        input.orderMailIds === undefined
          ? undefined
          : inArray(orderMail.id, [...input.orderMailIds]),
      ),
    )
    .orderBy(asc(orderMail.id));
  return lock ? query.for(lock) : query;
}

export type RetainedMail = Awaited<ReturnType<typeof readRetainedMail>>[number];
