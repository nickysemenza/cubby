import { parseShortcodeFor, type EmailId } from "@cubby/schemas/identifiers";
import type { mailFinancialAssociation } from "@cubby/schemas/mailbox-research";
import { desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  emailFinancialAssociation,
  financialAccount,
  financialTransaction,
} from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";

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
      evidence: emailFinancialAssociation,
      transaction: financialTransaction,
      reviewedAccount: financialAccount,
      currentAccount,
    })
    .from(emailFinancialAssociation)
    .innerJoin(
      financialTransaction,
      eq(financialTransaction.id, emailFinancialAssociation.transactionId),
    )
    .innerJoin(
      financialAccount,
      eq(financialAccount.id, emailFinancialAssociation.reviewedAccountId),
    )
    .innerJoin(
      currentAccount,
      eq(currentAccount.id, financialTransaction.accountId),
    )
    .where(eq(emailFinancialAssociation.emailId, emailId))
    .orderBy(
      desc(emailFinancialAssociation.createdAt),
      emailFinancialAssociation.id,
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
