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

import { defineContract, mutation, query } from "~/contracts/define";

export const purchaseContract = defineContract("purchase", {
  products: query({
    input: purchaseProductsInput,
    output: purchaseProductsOut,
  }),
  link: mutation({
    input: linkExpensesToPurchaseInput,
    output: purchaseOut,
  }),
  split: mutation({
    input: splitExpenseInput,
    output: splitExpenseOut,
  }),
  merge: mutation({
    input: mergePurchasesInput,
    output: mergePurchasesOut,
  }),
  attachProducts: mutation({
    input: purchaseProductMutationInput,
    output: purchaseProductMutationOut,
  }),
  detachProducts: mutation({
    input: purchaseProductMutationInput,
    output: purchaseProductMutationOut,
  }),
});
