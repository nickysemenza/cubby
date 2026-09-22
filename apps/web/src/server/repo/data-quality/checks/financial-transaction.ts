import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";
import { sql } from "drizzle-orm";

import { financialTransaction } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type FinancialTransaction = typeof financialTransaction;

const settlementKindList = sql.raw(
  purchaseSettlementKinds.map((kind) => `'${kind}'`).join(", "),
);

const hasLiveAllocation = (t: FinancialTransaction) => sql`EXISTS (
  SELECT 1 FROM "FinancialTransactionAllocation" dq_fta
  WHERE dq_fta."transactionId" = ${t.id} AND dq_fta."deletedAt" IS NULL
)`;

export const financialTransactionChecks = defineEntityChecks({
  entity: "financialTransaction",
  table: financialTransaction,
  checks: {
    financial_transaction_allocation: {
      // Only a posted, settlement-eligible transaction that is not itself
      // ledger-transfer evidence is expected to allocate to a Purchase
      // (mirrors `purchaseSettlementKinds`, financial-transaction.ts).
      expected: (t) =>
        sql`(${t.status} = 'posted' AND ${t.kind} IN (${settlementKindList}) AND ${t.ledgerTransferId} IS NULL)`,
      missing: (t) => sql`NOT ${hasLiveAllocation(t)}`,
    },
    financial_transaction_merchant: {
      missing: (t) => sql`(${t.merchant} IS NULL OR trim(${t.merchant}) = '')`,
    },
  },
});
