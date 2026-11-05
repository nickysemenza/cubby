import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";
import { and, inArray, ne, sql, type SQL } from "drizzle-orm";

import {
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/generated/entity-table-definitions.gen";
import { notDeleted } from "~/server/db/helpers/predicates";

export const SETTLEMENT_CANDIDATE_WINDOW_DAYS = 45;

/** New candidates can affect advice whose retained basis never read them. */
export function settlementCandidatePurchaseIdsSql(transactionIds: SQL): SQL {
  return sql`SELECT DISTINCT target.id FROM "FinancialTransaction" changed
    JOIN "Purchase" target ON target.date BETWEEN
      coalesce(changed."postedDate", changed."transactionDate")::date - ${SETTLEMENT_CANDIDATE_WINDOW_DAYS}::int
      AND coalesce(changed."postedDate", changed."transactionDate")::date + ${SETTLEMENT_CANDIDATE_WINDOW_DAYS}::int
    WHERE changed.id IN (${transactionIds}) AND ${notDeleted("target")}`;
}

/** Caller joins each allocation to its transaction. Both must be live. */
export const liveSettlementAllocationWhere: SQL = and(
  notDeleted(financialTransactionAllocation),
  inArray(financialTransaction.kind, [...purchaseSettlementKinds]),
  notDeleted(financialTransaction),
  ne(financialTransaction.status, "void"),
)!;
