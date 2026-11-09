import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { minorToDollarsSql } from "~/server/db/computed/money";
import { notDeleted } from "~/server/db/helpers/predicates";
import { outer } from "~/server/db/helpers/related";
import { financialAccount, financialTransaction } from "~/server/db/schema";

export const financialTransactionWorkFacts = () => ({
  amount: minorToDollarsSql(
    outer(financialTransaction.amount),
    "numeric",
  ).mapWith(Number),
  date: sql`coalesce(${outer(financialTransaction.postedDate)}, ${outer(financialTransaction.transactionDate)})`,
});
export const financialTransactionWorkOwners = (id: SQL) =>
  sql`ARRAY(SELECT account."ledgerPartyId" FROM "FinancialTransaction" transaction JOIN "FinancialAccount" account ON account.id = transaction."accountId" AND ${notDeleted(alias(financialAccount, "account"))} WHERE transaction.id = ${id} AND ${notDeleted(alias(financialTransaction, "transaction"))})`;
