import type {
  FinancialSpendingAdvice,
  FinancialSpendingPlan,
} from "@cubby/schemas/financial-booking";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { StatementTransactionJudgment } from "@cubby/schemas/statement-suggestion";
import { eq } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { financialAccount, financialTransaction } from "~/server/db/schema";
import {
  previewFinancialSpending,
  previewFinancialSpendings,
  prepareFinancialSpendingPage,
  prepareFinancialSpendingCandidates,
  type FinancialSpendingPage,
} from "~/server/domains/financial-transaction/repo/financial-spending";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { statementAttachCandidate } from "~/server/domains/transaction-import/repo/statement-charge";
import { changedTerms } from "~/server/generic/suggestions/repo/suggestion-presentation";

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

/** The booking request a judgment previews: its matched Transaction or new spending. */
function spendingRequest(
  judgment: StatementTransactionJudgment & {
    create: NonNullable<StatementTransactionJudgment["create"]>;
  },
  account: { shortcode: string },
  matched: { shortcode: string } | null | undefined,
  advice: FinancialSpendingAdvice | null,
): Parameters<typeof previewFinancialSpendings>[1][number] {
  if (matched)
    return {
      request: {
        transactionId: parseShortcodeFor(
          "financialTransaction",
          matched.shortcode,
        ),
        advice,
      },
      attachment:
        judgment.recommended === "attach"
          ? { settlementRef: judgment.create.sourceRef }
          : judgment.recommended === "supersede" &&
              !judgment.matchedTransactionId
            ? {
                settlementRef: judgment.create.sourceRef,
                fields: {
                  amount: judgment.create.amount,
                  status: "posted",
                  postedDate: judgment.statementDate,
                },
              }
            : undefined,
    };
  return {
    request: {
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
  };
}

/**
 * Many judgments' plans from one facts page: each previews exactly as
 * {@link prepareStatementSpending} does with that page, and categories resolve
 * once for the whole set.
 */
export async function prepareStatementSpendings(
  db: Database,
  entries: readonly {
    judgment: StatementTransactionJudgment;
    advice: FinancialSpendingAdvice | null;
  }[],
  page?: FinancialSpendingPage,
): Promise<(FinancialSpendingPlan | null)[]> {
  const plans: (FinancialSpendingPlan | null)[] = entries.map(() => null);
  const planned = entries.flatMap(({ judgment }, index) =>
    judgment.create && judgment.recommended !== "void" ? [index] : [],
  );
  if (!planned.length) return plans;
  const facts =
    page ??
    (await prepareStatementSpendingFacts(
      db,
      planned.map((index) => entries[index]!.judgment),
    ));
  const requests = planned.flatMap((index) => {
    const { judgment, advice } = entries[index]!;
    const account = facts.accounts.get(judgment.accountId);
    if (!account || !judgment.create) return [];
    const targetId = spendingTarget(judgment);
    const matched = targetId ? facts.transactions.get(targetId) : null;
    // A named target the page cannot see previews nothing, as the scalar path.
    if (targetId && !matched) return [];
    return [
      {
        index,
        entry: spendingRequest(
          { ...judgment, create: judgment.create },
          account,
          matched,
          advice,
        ),
      },
    ];
  });
  const previews = await previewFinancialSpendings(
    db,
    requests.map(({ entry }) => entry),
    facts,
  );
  for (const [position, { index }] of requests.entries())
    plans[index] = previews[position]!;
  return plans;
}

/** Booking terms a reviewed or automatic application commits to. */
const reviewedBooking = (plan: FinancialSpendingPlan | null | undefined) =>
  plan?.status === "ready"
    ? {
        status: plan.status,
        effect: plan.effect,
        purchaserId: plan.purchaserId,
        vendorId: plan.vendorId,
        spendingCategoryId: plan.spendingCategoryId,
        purchaseId: plan.purchaseId,
      }
    : { status: plan?.status ?? null };

/** A published booking's terms that differ from its current replan. */
export const changedStatementBooking = (
  published: FinancialSpendingPlan | null | undefined,
  current: FinancialSpendingPlan | null | undefined,
) => {
  const changed = changedTerms({
    reviewed: reviewedBooking(published),
    current: reviewedBooking(current),
  });
  return (changed.includes("status") ? ["status"] : changed).map(
    (key) => `spending.${key}`,
  );
};

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

/** Account/transaction metadata is shared only while this read-only page is built. */
export async function prepareStatementSpendingFacts(
  db: Database,
  judgments: readonly StatementTransactionJudgment[],
  /** Advised Vendor names the page's plans will resolve, read once with it. */
  vendorNames: readonly string[] = [],
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
  await prepareFinancialSpendingCandidates(db, page, [
    ...new Set([
      ...vendorNames,
      ...judgments.flatMap((judgment) => {
        const name = judgment.spending?.request.advice?.vendorName;
        return name ? [name] : [];
      }),
    ]),
  ]);
  return page;
}

export async function prepareStatementSpendingPage(
  db: Database,
  judgments: readonly StatementTransactionJudgment[],
) {
  const page = await prepareStatementSpendingFacts(db, judgments);
  const plans = await prepareStatementSpendings(
    db,
    judgments.map((judgment) => ({ judgment, advice: null })),
    page,
  );
  for (const [index, judgment] of judgments.entries())
    judgment.spending = plans[index] ?? null;
}
