import {
  financialTransactionStatus,
  purchaseSettlementKinds,
} from "@cubby/schemas/financial-transaction";
import { sql, type SQL } from "drizzle-orm";

import { householdLocalDate } from "~/lib/household-date";
import { householdDaySql } from "~/server/db/helpers/query";

/** Two complete Monday-Friday days after the evidence date. The second
 * following weekday ends the grace at the next household midnight. Resolve
 * the evidence date once: its transaction lookup must not be inlined into
 * every deadline operand, and historical age must not expand a date series. */
export const awaitingPostingSql = (
  start: SQL,
  now = new Date(),
): SQL<boolean> => sql`(
  WITH evidence_day AS MATERIALIZED (SELECT (${start})::date AS day)
  SELECT COALESCE(${householdLocalDate(now)}::date <= day + CASE extract(isodow FROM day)
    WHEN 4 THEN 4
    WHEN 5 THEN 4
    WHEN 6 THEN 3
    ELSE 2 END, true)
  FROM evidence_day
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
