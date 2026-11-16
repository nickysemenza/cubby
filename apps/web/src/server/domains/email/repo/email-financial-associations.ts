import { parseShortcodeFor, type EmailId } from "@cubby/schemas/identifiers";
import type { mailFinancialAssociation } from "@cubby/schemas/mailbox-research";
import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";

import { type Database } from "~/server/db/database";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import {
  financialAccount,
  financialTransaction,
} from "~/server/db/retained-tables";
import {
  emailFinancialAssociationsRead,
  emailFinancialAssociationsReadFields,
} from "~/server/domains/email/repo/email-decision-sql";

/** Reviewed evidence survives soft-deleted targets; it is not current settlement. */
export async function readEmailFinancialAssociations(
  db: Database | DrizzleTransaction,
  emailId: EmailId,
): Promise<z.infer<typeof mailFinancialAssociation>[]> {
  const currentAccount = alias(
    financialAccount,
    "currentEmailFinancialAccount",
  );
  // includes-deleted: immutable reviewed history retains both target identities.
  const rows = await unwrapDb(db)
    .select({
      evidence: emailFinancialAssociationsReadFields,
      transaction: financialTransaction,
      reviewedAccount: financialAccount,
      currentAccount,
    })
    .from(emailFinancialAssociationsRead)
    .innerJoin(
      financialTransaction,
      eq(financialTransaction.id, emailFinancialAssociationsRead.transactionId),
    )
    .innerJoin(
      financialAccount,
      eq(financialAccount.id, emailFinancialAssociationsRead.reviewedAccountId),
    )
    .innerJoin(
      currentAccount,
      eq(currentAccount.id, financialTransaction.accountId),
    )
    .where(eq(emailFinancialAssociationsRead.emailId, emailId))
    .orderBy(
      desc(emailFinancialAssociationsRead.createdAt),
      emailFinancialAssociationsRead.id,
    );
  return rows.map(
    ({ evidence, transaction, reviewedAccount, currentAccount: current }) => ({
      transactionId: parseShortcodeFor(
        "financialTransaction",
        transaction.shortcode,
      ),
      reviewedAccountId: parseShortcodeFor(
        "financialAccount",
        reviewedAccount.shortcode,
      ),
      currentAccountId:
        transaction.deletedAt || current.deletedAt
          ? null
          : parseShortcodeFor("financialAccount", current.shortcode),
      sourceAccountLabel: evidence.sourceAccountLabel,
      reviewReason: evidence.reviewReason,
      evidenceChecksum: evidence.evidenceChecksum,
      reviewedAt: evidence.createdAt.toISOString(),
      transactionDeleted: transaction.deletedAt !== null,
      reviewedAccountDeleted: reviewedAccount.deletedAt !== null,
      accountChanged: transaction.accountId !== evidence.reviewedAccountId,
    }),
  );
}
