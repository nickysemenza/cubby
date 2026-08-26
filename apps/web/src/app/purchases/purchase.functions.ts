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
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const purchase = defineOperationDomain("purchase", {
  products: query({
    input: purchaseProductsInput,
    output: purchaseProductsOut,
    tags: [["purchase"], ["purchase", "products"]],
  }),
  link: mutation({
    input: linkExpensesToPurchaseInput,
    output: purchaseOut,
    invalidates: [["purchase"]],
  }),
  split: mutation({
    input: splitExpenseInput,
    output: splitExpenseOut,
    invalidates: [["purchase"]],
  }),
  merge: mutation({
    input: mergePurchasesInput,
    output: mergePurchasesOut,
    invalidates: [["purchase"]],
  }),
  attachProducts: mutation({
    input: purchaseProductMutationInput,
    output: purchaseProductMutationOut,
    invalidates: [["purchase"]],
  }),
  detachProducts: mutation({
    input: purchaseProductMutationInput,
    output: purchaseProductMutationOut,
    invalidates: [["purchase"]],
  }),
});
