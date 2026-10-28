import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { chargeKeyOf } from "~/server/domains/transaction-import/repo/statement-charge";

/** Kinds that retrieve transfer evidence, without proving a transfer. */
export const transferPairMoneyMoveKinds = [
  financialTransactionKind.enum.account_transfer,
  financialTransactionKind.enum.credit_card_payment,
];

/**
 * The seed identities a scan pages; `createdBefore` is the population
 * boundary a Sweep step froze with its count, so late arrivals wait for the
 * next pass.
 */
type SeedBoundary = {
  since: string | null;
  createdBefore?: string | null;
};

const seedQueries = (input: SeedBoundary) => ({
  transactions: sql`
      SELECT 'ftx:' || ft.shortcode AS key FROM "FinancialTransaction" ft
      WHERE ${notDeleted("ft")} AND ft.status IN (${sql.join(
        [
          financialTransactionStatus.enum.observed,
          financialTransactionStatus.enum.pending,
          financialTransactionStatus.enum.posted,
        ].map((status) => sql`${status}`),
        sql`, `,
      )})
        AND ft."ledgerTransferId" IS NULL
        AND COALESCE(ft."postedDate", ft."transactionDate") IS NOT NULL
        AND (ft.kind IN (${sql.join(
          transferPairMoneyMoveKinds.map((kind) => sql`${kind}`),
          sql`, `,
        )}) OR ft."sourceCategory" IS NOT NULL)
        ${input.since ? sql`AND COALESCE(ft."postedDate", ft."transactionDate") >= ${input.since}::date` : sql``}
        ${input.createdBefore ? sql`AND ft."createdAt" <= ${input.createdBefore}::timestamptz` : sql``}
  `,
  statements: sql`
      SELECT 'stmt:' || r.source || ':' || ${chargeKeyOf("r")} AS key
      FROM "SourceTransactionRecord" r
      WHERE ${notDeleted("r")} AND r."sourceCategory" IS NOT NULL
        ${input.since ? sql`AND r."statementDate" >= ${input.since}::date` : sql``}
        ${input.createdBefore ? sql`AND r."createdAt" <= ${input.createdBefore}::timestamptz` : sql``}`,
});

export const transferPairSeedKeys = (input: SeedBoundary) => {
  const queries = seedQueries(input);
  return sql`${queries.transactions} UNION ${queries.statements}`;
};

/** Each disjoint origin contributes its first K unique keys to the global first K.
 * Statement identity and the cursor both use byte ordering, so the work index
 * can stream duplicate observations without sorting the remaining ledger. */
export const transferPairSeedPage = (
  input: SeedBoundary & { after: string | null; limit: number },
) => {
  const queries = seedQueries(input);
  const after = input.after
    ? sql`WHERE key COLLATE "C" > ${input.after} COLLATE "C"`
    : sql``;
  return sql`
    SELECT key FROM (
      (SELECT key FROM (${queries.transactions}) transactions ${after}
        ORDER BY key COLLATE "C" LIMIT ${input.limit})
      UNION ALL
      (SELECT DISTINCT key COLLATE "C" AS key FROM (${queries.statements}) observations ${after}
        ORDER BY key COLLATE "C" LIMIT ${input.limit})
    ) seeds ORDER BY key COLLATE "C" LIMIT ${input.limit}
  `;
};
