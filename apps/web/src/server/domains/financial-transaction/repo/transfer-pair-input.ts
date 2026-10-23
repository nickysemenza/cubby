import {
  financialTransactionKind,
  financialTransactionStatus,
} from "@cubby/schemas/financial-transaction";
import { sql } from "drizzle-orm";

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
export const transferPairSeedKeys = (input: {
  since: string | null;
  createdBefore?: string | null;
}) => sql`
      SELECT 'ftx:' || ft.shortcode AS key FROM "FinancialTransaction" ft
      WHERE ft."deletedAt" IS NULL AND ft.status IN (${sql.join(
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
      UNION
      SELECT 'stmt:' || r.source || ':' || ${chargeKeyOf("r")} AS key
      FROM "SourceTransactionRecord" r
      WHERE r."deletedAt" IS NULL AND r."sourceCategory" IS NOT NULL
        ${input.since ? sql`AND r."statementDate" >= ${input.since}::date` : sql``}
        ${input.createdBefore ? sql`AND r."createdAt" <= ${input.createdBefore}::timestamptz` : sql``}`;
