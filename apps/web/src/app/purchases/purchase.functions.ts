import { purchaseContract } from "~/contracts/purchase.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const purchase = defineOperationDomain(purchaseContract, {
  products: { tags: [["purchase", "products"]] },
  link: { invalidates: ripple.purchase },
  split: {
    // Splitting replaces one Expense with several, so it ripples as an EXPENSE
    // write (a superset of the purchase one, plus the calendar).
    invalidates: ripple.expense,
  },
});
