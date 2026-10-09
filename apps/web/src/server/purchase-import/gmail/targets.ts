import type { MailboxScopedQuery } from "@cubby/schemas/mailbox-research";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { Database } from "~/server/db";
import { account } from "~/server/db/auth.schema";
import {
  ledgerParty,
  vendor,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { vendorSearchTerms } from "./vendor-identity";

export type GmailSyncTarget = {
  ledgerPartyId: string;
  userId: string;
  mailboxId: string;
  scopedQueries: MailboxScopedQuery[];
};

/**
 * Members whose login has connected Google: the mailboxes a scheduled
 * discovery pass reads. A member who never connected Gmail gets no pass (and
 * no failing Run) until they do.
 */
export async function listGmailSyncTargets(
  db: Database,
): Promise<GmailSyncTarget[]> {
  const [members, vendors, charges] = await Promise.all([
    db
      .clientForRepository()
      .selectDistinct({
        ledgerPartyId: ledgerParty.id,
        userId: ledgerParty.userId,
        mailboxId: account.accountId,
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
        id: vendor.id,
        name: vendor.name,
        website: vendor.website,
        orderEmailSenders: vendor.orderEmailSenders,
      })
      .from(vendor)
      .where(notDeleted(vendor)),
    getDb(db)
      .select({
        id: financialTransaction.id,
        merchant: financialTransaction.merchant,
        ledgerPartyId: financialAccount.ledgerPartyId,
      })
      .from(financialTransaction)
      .innerJoin(
        financialAccount,
        and(
          eq(financialAccount.id, financialTransaction.accountId),
          notDeleted(financialAccount),
        ),
      )
      .leftJoin(
        financialTransactionAllocation,
        and(
          eq(
            financialTransactionAllocation.transactionId,
            financialTransaction.id,
          ),
          notDeleted(financialTransactionAllocation),
        ),
      )
      .where(
        and(
          notDeleted(financialTransaction),
          isNull(financialTransactionAllocation.id),
          isNotNull(financialTransaction.merchant),
        ),
      ),
  ]);
  const quote = (value: string) => `"${value.replaceAll('"', " ")}"`;
  const vendorQueries = vendors.map((row) => ({
    key: `vendor:${row.id}`,
    query: `{${quote(row.name)} ${vendorSearchTerms(row)
      .map((term) => `from:${term}`)
      .join(" ")}}`,
  }));
  return members.flatMap((row) =>
    row.userId && row.mailboxId
      ? [
          {
            ledgerPartyId: row.ledgerPartyId,
            userId: row.userId,
            mailboxId: row.mailboxId,
            scopedQueries: [
              ...vendorQueries,
              ...charges
                .filter(
                  (charge) =>
                    charge.ledgerPartyId === row.ledgerPartyId &&
                    charge.merchant?.trim(),
                )
                .map((charge) => ({
                  key: `charge:${charge.id}`,
                  query: quote(charge.merchant!),
                })),
            ],
          },
        ]
      : [],
  );
}
