import { parseBankDescriptor } from "@cubby/schemas/financial-transaction-fields";
import type { MailboxScopedQuery } from "@cubby/schemas/mailbox-research";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";

import { account } from "~/server/db/auth.schema";
import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  ledgerParty,
  vendor,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/retained-tables";

import { vendorSearchTerms } from "./vendor-identity";
import { vendorMailQueries } from "./vendor-mail-scope";

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
    getDb(db)
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
    getDb(db)
      .select({
        id: vendor.id,
        website: vendor.website,
        orderEmailSenders: vendor.orderEmailSenders,
      })
      .from(vendor)
      .where(notDeleted(vendor)),
    getDb(db)
      .select({
        merchant: financialTransaction.merchant,
        rawDescription: financialTransaction.rawDescription,
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
          or(
            isNotNull(financialTransaction.merchant),
            isNotNull(financialTransaction.rawDescription),
          ),
        ),
      ),
  ]);
  const quote = (value: string) => `"${value.replaceAll('"', " ")}"`;
  // One search per distinct merchant (case- and space-insensitive): many
  // unallocated charges share a merchant, and Gmail search ignores case. The
  // query derives from the normalized merchant alone, so allocating one
  // spelling never changes the query text and resets its saved coverage.
  // A charge without a provider merchant searches its cleaned bank
  // descriptor instead (`parseBankDescriptor`), keyed apart from merchants.
  const merchantQueries = (
    rows: readonly { merchant: string | null; rawDescription: string | null }[],
  ) =>
    [
      ...new Set(
        rows.flatMap((charge) => {
          const merchant = charge.merchant
            ?.trim()
            .replace(/\s+/gu, " ")
            .toLowerCase();
          if (merchant) return [`merchant:${merchant}`];
          const descriptor = parseBankDescriptor(
            charge.rawDescription,
          ).merchant;
          return descriptor ? [`descriptor:${descriptor}`] : [];
        }),
      ),
    ].map((key) => ({
      key,
      query: quote(key.slice(key.indexOf(":") + 1)),
    }));
  // A Vendor without a verified sender or website domain waits for research.
  const vendorQueries = vendors.flatMap((row) =>
    vendorMailQueries(row.id, vendorSearchTerms(row)),
  );
  return members.flatMap((row) =>
    row.userId && row.mailboxId
      ? [
          {
            ledgerPartyId: row.ledgerPartyId,
            userId: row.userId,
            mailboxId: row.mailboxId,
            scopedQueries: [
              ...vendorQueries,
              ...merchantQueries(
                charges.filter(
                  (charge) => charge.ledgerPartyId === row.ledgerPartyId,
                ),
              ),
            ],
          },
        ]
      : [],
  );
}
