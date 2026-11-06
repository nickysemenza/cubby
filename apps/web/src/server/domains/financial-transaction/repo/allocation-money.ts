import { minorToMoney } from "@cubby/shared";

import type { financialTransactionAllocation } from "~/server/db/schema";

/** Retained fingerprints and client results keep their original dollar shape and key order. */
export const allocationDollars = (
  row: typeof financialTransactionAllocation.$inferSelect,
) => ({
  id: row.id,
  transactionId: row.transactionId,
  purchaseId: row.purchaseId,
  amount: minorToMoney(row.amountMinor),
  confirmsMerchant: row.confirmsMerchant,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt,
});
