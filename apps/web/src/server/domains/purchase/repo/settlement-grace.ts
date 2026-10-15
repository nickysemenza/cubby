import {
  financialTransactionStatus,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import { sql, type SQL } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import { householdDaySql } from "~/server/db/helpers";

/** Two complete Monday-Friday days after the evidence date; imports never reset dated evidence. */
export const awaitingPostingSql = (
  start: SQL,
  now = new Date(),
): SQL<boolean> => sql`(
  SELECT count(*) < 2 FROM generate_series((${start})::date + 1, ${householdLocalDate(now)}::date - 1, interval '1 day') day
  WHERE extract(isodow FROM day) BETWEEN 1 AND 5
)`;

export const transactionPostingStartSql = (alias: string): SQL => sql`coalesce(
  ${sql.raw(`${alias}."transactionDate"`)}, ${sql.raw(`${alias}."postedDate"`)},
  ${householdDaySql(sql.raw(`${alias}."createdAt"`))})`;

export const purchasePostingStartSql = (alias: string): SQL => sql`coalesce((
  SELECT max(coalesce(ft."transactionDate", ft."postedDate", ${householdDaySql(sql`ft."createdAt"`)}))
  FROM "FinancialTransactionAllocation" allocation JOIN "FinancialTransaction" ft ON ft.id = allocation."transactionId"
  WHERE allocation."purchaseId" = ${sql.raw(`${alias}.id`)} AND allocation."deletedAt" IS NULL
    AND ft."deletedAt" IS NULL AND ft.status <> ${financialTransactionStatus.enum.void}
    AND ft.kind IN (${sql.join(
      purchaseSettlementKinds.map((kind) => sql`${kind}`),
      sql`, `,
    )})
), ${sql.raw(`${alias}.date`)}, ${householdDaySql(sql.raw(`${alias}."createdAt"`))})`;
