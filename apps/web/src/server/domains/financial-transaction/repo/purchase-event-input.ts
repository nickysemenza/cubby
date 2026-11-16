import type { manualEntry } from "~/server/db/kernel-schema";
import type {
  expense,
  expenseAttribution,
  financialAccount,
  financialTransaction,
  financialTransactionAllocation,
  ledgerParty,
  purchase,
  purchasePaymentEvidence,
  sourceOccurrence,
  spendingCategory,
  vendor,
} from "~/server/db/schema";
import type { OrderBookingInput } from "~/server/domains/purchase-import/policy/order-booking";
import type { recordedAttributionMargins } from "~/server/domains/purchase-import/policy/replacement-attributions";
import type { Binding } from "~/server/kernel/api";

export type Input = {
  key: string;
  bindings: Binding[];
  orderBindings: Binding[];
  orders: OrderBookingInput[];
  lumpAttributions: ReturnType<typeof recordedAttributionMargins>;
  transactions: (typeof financialTransaction.$inferSelect)[];
  accounts: (typeof financialAccount.$inferSelect)[];
  parties: (typeof ledgerParty.$inferSelect)[];
  purchases: (typeof purchase.$inferSelect)[];
  expenses: (typeof expense.$inferSelect)[];
  /** Source-backed unpriced item details whose money a separate aggregate carries. */
  carriedExpenseIds: string[];
  allocations: (typeof financialTransactionAllocation.$inferSelect)[];
  attributions: (typeof expenseAttribution.$inferSelect)[];
  vendors: (typeof vendor.$inferSelect)[];
  categories: (typeof spendingCategory.$inferSelect)[];
  payments: (typeof purchasePaymentEvidence.$inferSelect)[];
  occurrences: (typeof sourceOccurrence.$inferSelect)[];
  /** The source occurrences behind each other charge that settles a loaded Purchase. */
  settlementOccurrences: {
    transactionId: string;
    occurrence: typeof sourceOccurrence.$inferSelect;
  }[];
  manuals: (typeof manualEntry.$inferSelect)[];
};
