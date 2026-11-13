import { getTableName, sql, type SQL } from "drizzle-orm";

import { columnArrayParam } from "~/server/db/helpers/array-param";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  expense,
  purchase,
} from "~/server/db/schema";
import { defineReadIndex } from "~/server/kernel/api";

/** The undated part of decideSpendingCandidates: an incurred, partially or uncertainly paid Purchase. */
const partlyPaid = (id: SQL) => sql`
  EXISTS (SELECT 1 FROM "Expense" e WHERE e."purchaseId"=${id} AND ${notDeleted("e")} AND NOT e.future AND e."economicRole"=${"vendor"})
  AND EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" a WHERE a."purchaseId"=${id} AND ${notDeleted("a")} AND a."amountMinor">0)
  AND (
    EXISTS (SELECT 1 FROM "Expense" e WHERE e."purchaseId"=${id} AND ${notDeleted("e")} AND NOT e.future AND e."economicRole"=${"vendor"} AND (e."costMinor" IS NULL OR e."lineKind"=${"unclassified"}))
    OR EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" a
      LEFT JOIN "FinancialTransaction" t ON t.id=a."transactionId" AND ${notDeleted("t")}
      LEFT JOIN "FinancialAccount" account ON account.id=t."accountId" AND ${notDeleted("account")}
      WHERE a."purchaseId"=${id} AND ${notDeleted("a")} AND a."amountMinor">0 AND (
        t.id IS NULL OR account.id IS NULL
        OR t.status IN (${"void"},${"expected"}) OR t."ledgerTransferId" IS NOT NULL OR t."amountMinor"<=0
        OR t.kind NOT IN (${"purchase"},${"fee"},${"refund"})
        OR t."amountMinor" <> (SELECT coalesce(sum(total."amountMinor"),0) FROM "FinancialTransactionAllocation" total WHERE total."transactionId"=t.id AND ${notDeleted("total")})
        OR EXISTS (SELECT 1 FROM "Expense" reimbursement WHERE reimbursement."purchaseId"=${id} AND ${notDeleted("reimbursement")} AND reimbursement."economicRole"=${"reimbursement"})
      ))
    OR (SELECT coalesce(sum(e."costMinor"),0) FROM "Expense" e WHERE e."purchaseId"=${id} AND ${notDeleted("e")} AND NOT e.future AND e."economicRole"=${"vendor"} AND (e."costMinor">=0 OR e."lineKind"<>${"principal"}))
      > (SELECT coalesce(sum(a."amountMinor"),0) FROM "FinancialTransactionAllocation" a WHERE a."purchaseId"=${id} AND ${notDeleted("a")} AND a."amountMinor">0)
  )`;

export const partlyPaidPurchases = defineReadIndex(purchase, {
  name: "purchase.partlyPaidVendor",
  values: (row) => (row.vendorId ? [row.vendorId] : []),
  where: (values) =>
    sql`${purchase.vendorId}=ANY(${columnArrayParam(values)}) AND ${purchase.deletedAt} IS NULL AND ${partlyPaid(sql`${purchase.id}`)}`,
  related: {
    tables: [
      purchase,
      expense,
      financialTransactionAllocation,
      financialTransaction,
      financialAccount,
    ],
    async load(db, changes) {
      if (
        changes.every(
          (change) =>
            change.table === getTableName(financialTransaction) &&
            !change.before &&
            change.after &&
            !("createdAt" in change.after),
        )
      )
        return [];
      const rows = changes.map((change) => ({
        table: change.table,
        id: change.id,
        parents: [
          ...new Set(
            [change.before?.purchaseId, change.after?.purchaseId].filter(
              (id): id is string => typeof id === "string",
            ),
          ),
        ],
        vendors: [
          ...new Set(
            [change.before?.vendorId, change.after?.vendorId].filter(
              (id): id is string => typeof id === "string",
            ),
          ),
        ],
      }));
      const result = await repositoryQueries(db).execute<{
        id: string;
        values: string[];
        matches: boolean;
      }>(sql`
        WITH changes AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS c("table" text,id uuid,parents jsonb,vendors jsonb)),
        parents AS (
          SELECT id FROM changes WHERE "table"=${getTableName(purchase)}
          UNION SELECT value::uuid FROM changes CROSS JOIN LATERAL jsonb_array_elements_text(parents)
          UNION SELECT a."purchaseId" FROM changes c JOIN "FinancialTransactionAllocation" a ON a."transactionId"=c.id WHERE c."table"=${getTableName(financialTransaction)}
          UNION SELECT a."purchaseId" FROM changes c JOIN "FinancialTransaction" t ON t."accountId"=c.id JOIN "FinancialTransactionAllocation" a ON a."transactionId"=t.id WHERE c."table"=${getTableName(financialAccount)}
        ), vendors AS (
          SELECT p.id,p."vendorId" AS vendor FROM "Purchase" p JOIN parents ON parents.id=p.id WHERE p."vendorId" IS NOT NULL
          UNION SELECT c.id,value::uuid FROM changes c CROSS JOIN LATERAL jsonb_array_elements_text(c.vendors) WHERE c."table"=${getTableName(purchase)}
        )
        SELECT v.id,jsonb_build_array(v.vendor::text) AS values,
          (p.id IS NOT NULL AND ${notDeleted("p")} AND ${partlyPaid(sql`p.id`)}) AS matches
        FROM vendors v LEFT JOIN "Purchase" p ON p.id=v.id`);
      return result.rows;
    },
  },
});
