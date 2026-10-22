import type { FinancialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import { eq } from "drizzle-orm";

import { forEachConcurrently } from "~/lib/concurrency-limiter";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { financialAccount, financialTransaction } from "~/server/db/schema";
import {
  previewFinancialSpending,
  prepareFinancialSpendingPage,
  type FinancialSpendingPage,
} from "~/server/domains/financial-transaction/repo/financial-spending";

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
        where: eq(
          financialAccount.id,
          parseEntityId("financialAccount", judgment.accountId),
        ),
      });
  if (!account) return null;
  const targetId = spendingTarget(judgment);
  const matched = targetId
    ? page
      ? page.transactions.get(targetId)
      : await getDb(db).query.financialTransaction.findFirst({
          where: eq(
            financialTransaction.id,
            parseEntityId("financialTransaction", targetId),
          ),
        })
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

const spendingTarget = (judgment: StatementTransactionJudgment) =>
  judgment.matchedTransactionId ??
  (judgment.recommended === "attach" && judgment.candidates.length === 1
    ? judgment.candidates[0]!.transactionId
    : null);

/**
 * Spending previews prepared at once per statement page. It leaves pooled
 * connections for publication and speculative label work.
 */
export const STATEMENT_SPENDING_PREPARATION_CONCURRENCY = 4;

/** Account/transaction metadata is shared only while this read-only page is built. */
export async function prepareStatementSpendingPage(
  db: Database,
  judgments: readonly StatementTransactionJudgment[],
) {
  const page = await prepareFinancialSpendingPage(db, {
    accountIds: judgments.map((judgment) =>
      parseEntityId("financialAccount", judgment.accountId),
    ),
    transactionIds: judgments.flatMap((judgment) => {
      const target = spendingTarget(judgment);
      return target ? [parseEntityId("financialTransaction", target)] : [];
    }),
  });
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
