import type { FinancialSpendingAdvice } from "@cubby/schemas/financial-booking";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { financialAccount, financialTransaction } from "~/server/db/schema";
import { previewFinancialSpending } from "~/server/domains/financial-transaction/repo/financial-spending";

/** Statement observations supply evidence to the shared financial planner. */
export async function prepareStatementSpending(
  db: Database,
  judgment: StatementTransactionJudgment,
  advice: FinancialSpendingAdvice | null = judgment.spending?.request.advice ??
    null,
) {
  if (!judgment.create || judgment.recommended === "void") return null;
  const account = await getDb(db).query.financialAccount.findFirst({
    where: eq(
      financialAccount.id,
      parseEntityId("financialAccount", judgment.accountId),
    ),
  });
  if (!account) return null;
  const targetId =
    judgment.matchedTransactionId ??
    (judgment.recommended === "attach" && judgment.candidates.length === 1
      ? judgment.candidates[0]!.transactionId
      : null);
  const matched = targetId
    ? await getDb(db).query.financialTransaction.findFirst({
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
    );
  return previewFinancialSpending(db, {
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
  });
}
