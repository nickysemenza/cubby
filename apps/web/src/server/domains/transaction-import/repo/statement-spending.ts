import type { FinancialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { financialAccount, financialTransaction } from "~/server/db/schema";
import {
  previewFinancialSpending,
  prepareFinancialSpendingPage,
  prepareFinancialSpendingCandidates,
  type FinancialSpendingPage,
} from "~/server/domains/financial-transaction/repo/financial-spending";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { statementAttachCandidate } from "~/server/domains/transaction-import/repo/statement-charge";

/** Statement observations supply evidence to the shared financial planner. */
export async function prepareStatementSpending(
  db: Database,
  judgment: StatementTransactionJudgment,
  advice: FinancialSpendingAdvice | null = judgment.spending?.request.advice ??
    null,
  page?: FinancialSpendingPage,
) {
  if (!judgment.create || judgment.recommended === "void") return null;
  const account = page
    ? page.accounts.get(judgment.accountId)
    : await getDb(db).query.financialAccount.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              eq(
                financialAccount.id,
                parseEntityId("financialAccount", judgment.accountId),
              ),
            ),
        },
      });
  if (!account) return null;
  const targetId = spendingTarget(judgment);
  const matched = targetId
    ? page
      ? page.transactions.get(targetId)
      : await getDb(db)
          .query.financialTransaction.findFirst({
            where: {
              RAW: (table: PgTable) =>
                relationalSql(
                  table,
                  eq(
                    financialTransaction.id,
                    parseEntityId("financialTransaction", targetId),
                  ),
                ),
            },
          })
          .then((row) => (row ? transactionDollars(row) : row))
    : null;
  if (matched)
    return previewFinancialSpending(
      db,
      {
        transactionId: parseShortcodeFor(
          "financialTransaction",
          matched.shortcode,
        ),
        advice,
      },
      judgment.recommended === "attach"
        ? { settlementRef: judgment.create.sourceRef }
        : judgment.recommended === "supersede" && !judgment.matchedTransactionId
          ? {
              settlementRef: judgment.create.sourceRef,
              fields: {
                amount: judgment.create.amount,
                status: "posted",
                postedDate: judgment.statementDate,
              },
            }
          : undefined,
      page,
    );
  return previewFinancialSpending(
    db,
    {
      source: {
        accountId: parseShortcodeFor("financialAccount", account.shortcode),
        kind: judgment.create.kind,
        status: judgment.create.status,
        amount: judgment.create.amount,
        transactionDate: judgment.create.transactionDate,
        postedDate: judgment.create.postedDate,
        merchant: judgment.create.merchant,
        rawDescription: judgment.create.rawDescription,
        sourceRefs: [judgment.create.sourceRef],
      },
      advice,
    },
    undefined,
    page,
  );
}

// A supersede settles the hold's own Transaction, so it previews that
// booking rather than new spending.
const spendingTarget = (judgment: StatementTransactionJudgment) =>
  judgment.matchedTransactionId ??
  (judgment.recommended === "supersede"
    ? judgment.supersede?.pendingTransactionId
    : null) ??
  (judgment.recommended === "attach"
    ? (statementAttachCandidate(judgment)?.transactionId ?? null)
    : null);

/**
 * Spending previews prepared at once per statement page. It leaves pooled
 * connections for publication and other background work.
 */
const STATEMENT_SPENDING_PREPARATION_CONCURRENCY = 4;

/** Account/transaction metadata is shared only while this read-only page is built. */
export async function prepareStatementSpendingFacts(
  db: Database,
  judgments: readonly StatementTransactionJudgment[],
) {
  const page = await prepareFinancialSpendingPage(db, {
    sources: judgments.flatMap((judgment) =>
      judgment.create ? [judgment.create] : [],
    ),
    accountIds: judgments.map((judgment) =>
      parseEntityId("financialAccount", judgment.accountId),
    ),
    transactionIds: judgments.flatMap((judgment) => {
      const target = spendingTarget(judgment);
      return target ? [parseEntityId("financialTransaction", target)] : [];
    }),
  });
  await prepareFinancialSpendingCandidates(db, page);
  return page;
}

export async function prepareStatementSpendingPage(
  db: Database,
  judgments: readonly StatementTransactionJudgment[],
) {
  const page = await prepareStatementSpendingFacts(db, judgments);
  await forEachConcurrently(
    judgments,
    STATEMENT_SPENDING_PREPARATION_CONCURRENCY,
    async (judgment) => {
      judgment.spending = await prepareStatementSpending(
        db,
        judgment,
        null,
        page,
      );
    },
  );
}
