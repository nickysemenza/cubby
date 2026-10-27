import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import {
  expense,
  financialAccount,
  financialTransaction,
} from "~/server/db/schema";
import {
  workPurchaseOwners,
  workPurchaseSourceOwners,
} from "~/server/domains/purchase/repo/work-owners";

export const workExpenseSourceOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT owner FROM "Expense" source_expense
  CROSS JOIN LATERAL unnest(${workPurchaseSourceOwners(sql`source_expense."purchaseId"`)}) owner
  WHERE source_expense.id = ${id} AND ${notDeleted(alias(expense, "source_expense"))}
)`;

export const workExpenseOwners = (id: SQL): SQL => sql`ARRAY(
  SELECT DISTINCT owner FROM "Expense" e
  CROSS JOIN LATERAL (
    SELECT unnest(${workPurchaseOwners(sql`e."purchaseId"`)}) AS owner
    UNION ALL
    SELECT account."ledgerPartyId"
    FROM "FinancialTransaction" transaction
    LEFT JOIN "FinancialAccount" account ON account.id = transaction."accountId" AND ${notDeleted(alias(financialAccount, "account"))}
    WHERE transaction.shortcode = e."bookingTransactionCode" AND ${notDeleted(alias(financialTransaction, "transaction"))}
  ) authority
  WHERE e.id = ${id} AND ${notDeleted(alias(expense, "e"))}
)`;
