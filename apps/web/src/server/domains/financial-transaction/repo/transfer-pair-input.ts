import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { CONNECTION_TRANSFER_WINDOW_DAYS } from "@cubby/schemas/entity-connections";
import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { transferPairJudgment } from "@cubby/schemas/transfer-pair-suggestion";
import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { chargeKeyOf } from "~/server/domains/transaction-import/repo/statement-charge";

/** Kinds that retrieve transfer evidence, without proving a transfer. */
export const transferPairMoneyMoveKinds = [
  financialTransactionKind.enum.account_transfer,
  financialTransactionKind.enum.credit_card_payment,
];

/** Discovery and invalidation use the same rounded absolute money pool. */
export const transferPoolAmountSql = (amount: SQL): SQL =>
  sql`round(abs(${amount}) * 100)::bigint`;

/** Recorded connection peers share discovery's numeric cents and date bounds. */
export function recordedTransferSourceIdsSql(refs: SQL): SQL {
  return sql`WITH changed_recorded_transfers AS MATERIALIZED (
      SELECT coalesce(changed."postedDate", changed."transactionDate")::date AS day,
        ${transferPoolAmountSql(sql`changed.amount::numeric`)} AS cents
      FROM "FinancialTransaction" changed WHERE changed.id IN (${refs})
    ) SELECT DISTINCT peer.id FROM changed_recorded_transfers changed
      JOIN "FinancialTransaction" peer ON
        coalesce(peer."postedDate", peer."transactionDate")::date BETWEEN
          changed.day - ${CONNECTION_TRANSFER_WINDOW_DAYS}::int
          AND changed.day + ${CONNECTION_TRANSFER_WINDOW_DAYS}::int
        AND ${transferPoolAmountSql(sql`peer.amount::numeric`)} = changed.cents`;
}

const pairFields = transferPairJudgment.keyof();

/** Find existing advice a newly reachable leg can change, without judging it. */
export function transferPairSourceAssessmentIdsSql(
  kind: "financialTransaction" | "sourceTransactionRecord" | "policy",
  refs: SQL,
): SQL {
  const pending = sql`s.family = ${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.transfer_pair)}
    AND s.active AND s.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}`;
  if (kind === "policy")
    // Accounts/cash destinations and removed booking or settlement claims can
    // admit legs absent from every retained judgment. Keep that scope complete.
    return sql`SELECT s.id FROM "Suggestion" s WHERE ${pending}`;
  const amounts =
    kind === "financialTransaction"
      ? sql`SELECT ${transferPoolAmountSql(sql`changed.amount`)} AS cents
        FROM "FinancialTransaction" changed WHERE changed.id IN (${refs})`
      : sql`SELECT ${transferPoolAmountSql(sql`changed.amount`)} AS cents
        FROM "SourceTransactionRecord" changed WHERE changed.id IN (${refs})`;
  const amount = sql`s.data->>${sqlEnumConstant(pairFields, pairFields.enum.amount)}`;
  // Historical invalid state stays unavailable; it must not abort unrelated
  // source expansion before the canonical producer can report its failure.
  const numericAmount = sql`CASE WHEN pg_input_is_valid(${amount}, ${"numeric"}) THEN (${amount})::numeric END`;
  return sql`SELECT s.id FROM "Suggestion" s WHERE ${pending}
    AND ${transferPoolAmountSql(numericAmount)} IN (${amounts})`;
}

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
