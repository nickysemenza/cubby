import {
  purchaseOrderMailInput,
  purchaseOrderMailOut,
} from "@cubby/schemas/order-mail-review";
import {
  linkExpensesToPurchaseInput,
  purchaseOut,
  purchaseProductsInput,
  purchaseProductsOut,
  purchaseSettlementCandidatesInput,
  purchaseSettlementCandidatesOut,
  reclassifyPurchaseDocumentInput,
  splitExpenseInput,
  splitExpenseOut,
} from "@cubby/schemas/purchase";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/**
 * `originalCost`/`partsSum`/`delta` confirm a priced split conserved its source
 * amount; `splitExpenseDelta` (`@cubby/schemas/purchase`) is the pure
 * computation, and the write path rejects a non-zero delta before replacing
 * the original Expense.
 */
export const splitExpenseWithDeltaOut = z.object({
  items: splitExpenseOut,
  originalCost: z
    .number()
    .nullable()
    .describe(
      "The original Expense's cost before the split, in dollars. Null only when the original had no recorded cost.",
    ),
  partsSum: z
    .number()
    .describe("Sum of the parts' `cost` as submitted, in dollars."),
  delta: z
    .number()
    .nullable()
    .describe(
      "partsSum minus originalCost, in dollars. Priced splits require zero; null when originalCost is null and there is no source amount to conserve.",
    ),
});

export const purchaseContract = defineContract("purchase", {
  settlementCandidates: query({
    input: purchaseSettlementCandidatesInput,
    output: purchaseSettlementCandidatesOut,
    cache: { tags: [["purchase"], ["financialTransaction"]] },
  }),
  orderMail: query({
    native: "Show linked order email events on native Purchase detail",
    input: purchaseOrderMailInput,
    output: purchaseOrderMailOut,
    cache: { tags: [["purchase"]] },
  }),
  products: query({
    input: purchaseProductsInput,
    output: purchaseProductsOut,
  }),
  link: mutation({
    input: linkExpensesToPurchaseInput,
    output: purchaseOut,
    invalidates: ["purchase"],
  }),
  split: mutation({
    input: splitExpenseInput,
    output: splitExpenseOut,
    invalidates: ["expense"],
  }),
  // Agent-facing (MCP `expenses`, `purchase_import`): off the HTTP API.
  /** `split` plus the conservation check an agent confirms before moving on. */
  splitWithDelta: mutation({
    http: false,
    input: splitExpenseInput,
    output: splitExpenseWithDeltaOut,
    invalidates: ["expense"],
  }),
  reclassifyDocument: mutation({
    http: false,
    input: reclassifyPurchaseDocumentInput,
    output: purchaseOut,
    invalidates: ["purchase"],
  }),
});
