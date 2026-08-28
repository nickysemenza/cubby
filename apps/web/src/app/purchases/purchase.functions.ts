import {
  linkExpensesToPurchaseInput,
  mergePurchasesInput,
  mergePurchasesOut,
  purchaseOut,
  purchaseProductMutationInput,
  purchaseProductMutationOut,
  purchaseProductsInput,
  purchaseProductsOut,
  splitExpenseInput,
  splitExpenseOut,
} from "@cubby/schemas/purchase";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const purchase = defineOperationDomain("purchase", {
  products: query({
    input: purchaseProductsInput,
    output: purchaseProductsOut,
    tags: [["purchase", "products"]],
  }),
  link: mutation({
    input: linkExpensesToPurchaseInput,
    output: purchaseOut,
    invalidates: ripple.purchase,
  }),
  split: mutation({
    input: splitExpenseInput,
    output: splitExpenseOut,
    // Splitting replaces one Expense with several, so it ripples as an EXPENSE
    // write (a superset of the purchase one, plus the calendar).
    invalidates: ripple.expense,
  }),
  merge: mutation({
    input: mergePurchasesInput,
    output: mergePurchasesOut,
    invalidates: ripple.purchase,
  }),
  attachProducts: mutation({
    input: purchaseProductMutationInput,
    output: purchaseProductMutationOut,
    invalidates: ripple.purchaseProduct,
  }),
  detachProducts: mutation({
    input: purchaseProductMutationInput,
    output: purchaseProductMutationOut,
    invalidates: ripple.purchaseProduct,
  }),
});
