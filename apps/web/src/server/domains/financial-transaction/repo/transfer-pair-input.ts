import { financialTransactionStatus } from "@cubby/schemas/financial-transaction";
import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { sourceObservations } from "~/server/domains/transaction-import/repo/source-observation-state";
import { chargeKeyOf } from "~/server/domains/transaction-import/repo/statement-charge";
import { MONEY_MOVE_KINDS } from "~/server/domains/transaction-import/repo/statement-transaction-kind";

/** Discovery and invalidation use the same rounded absolute money pool. */
export const transferPoolAmountSql = (amount: SQL): SQL =>
  sql`round(abs(${amount}) * 100)::bigint`;

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
          MONEY_MOVE_KINDS.map((kind) => sql`${kind}`),
          sql`, `,
        )}) OR ft."sourceCategory" IS NOT NULL)
        ${input.since ? sql`AND COALESCE(ft."postedDate", ft."transactionDate") >= ${input.since}::date` : sql``}
        ${input.createdBefore ? sql`AND ft."createdAt" <= ${input.createdBefore}::timestamptz` : sql``}
  `,
  statements: sql`
      SELECT 'stmt:' || r.source || ':' || ${chargeKeyOf("r")} AS key
      FROM ${sourceObservations} r
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
