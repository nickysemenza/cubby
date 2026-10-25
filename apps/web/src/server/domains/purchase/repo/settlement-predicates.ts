import { purchaseSettlementKinds } from "@cubby/schemas/financial-transaction";
import { and, inArray, ne, type SQL } from "drizzle-orm";

import {
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/generated/entity-table-definitions.gen";
import { notDeleted } from "~/server/db/helpers/predicates";

/** Caller joins each allocation to its transaction. Both must be live. */
export const liveSettlementAllocationWhere: SQL = and(
  notDeleted(financialTransactionAllocation),
  inArray(financialTransaction.kind, [...purchaseSettlementKinds]),
  notDeleted(financialTransaction),
  ne(financialTransaction.status, "void"),
)!;
