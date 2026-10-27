import { sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { financialAccount, financialTransaction } from "~/server/db/schema";

export const financialTransactionWorkFacts = () => ({
  amount: sql`${financialTransaction.amount}`,
  date: sql`coalesce(${financialTransaction.postedDate}, ${financialTransaction.transactionDate})`,
});
export const financialTransactionWorkOwners = (id: SQL) =>
  sql`ARRAY(SELECT account."ledgerPartyId" FROM "FinancialTransaction" transaction JOIN "FinancialAccount" account ON account.id = transaction."accountId" AND ${notDeleted(alias(financialAccount, "account"))} WHERE transaction.id = ${id} AND ${notDeleted(alias(financialTransaction, "transaction"))})`;
