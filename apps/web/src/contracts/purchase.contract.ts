import {
  linkExpensesToPurchaseInput,
  purchaseOut,
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
    mcp: {
      name: "link_expenses_to_purchase",
      description:
        "Re-parent existing Expenses onto ONE existing purchase — e.g. one plumbing transaction that spans both rough-in and fixtures. This only rewrites `purchaseId` on the given expenses; it creates no money, changes no cost/trade/costType/project on any Expense, and leaves the target purchase's identity (vendorId/orderId/date/statedTotal/documents) untouched aside from gaining those expenses. " +
        "NOT for payment schedules: a contractor's progress payments are separate transactions and therefore separate purchases. Do not combine them just because they share a project or vendor; use the Project rollup for that view. " +
        "REFUSES when `purchaseId` does not resolve to a live purchase.",
    },
    input: linkExpensesToPurchaseInput,
    output: purchaseOut,
  }),
  split: mutation({
    input: splitExpenseInput,
    output: splitExpenseOut,
  }),
});
