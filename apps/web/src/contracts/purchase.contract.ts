import { relationMutationOut } from "@cubby/schemas/common";
import {
  purchaseOrderMailInput,
  purchaseOrderMailOut,
} from "@cubby/schemas/order-mail-review";
import {
  linkExpensesToPurchaseInput,
  purchaseAttachProductsInput,
  purchaseLinkExpensesCandidatesInput,
  purchaseLinkExpensesCandidatesOut,
  purchaseLinkExpensesCheckInput,
  purchaseLinkExpensesCheckOut,
  purchaseLinkProductsCandidatesInput,
  purchaseLinkProductsCandidatesOut,
  purchaseOut,
  purchaseProductsInput,
  purchaseProductsOut,
  purchaseSettlementAllocationCheckInput,
  purchaseSettlementAllocationCheckOut,
  purchaseSettlementCandidatesInput,
  purchaseSettlementCandidatesOut,
  purchaseSettlementSuggestInput,
  purchaseSettlementSuggestOut,
  purchaseSplitCheckInput,
  purchaseSplitCheckOut,
  purchaseSplitStartInput,
  purchaseSplitStartOut,
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
    native: "Review statement activity near a Purchase",
    input: purchaseSettlementCandidatesInput,
    output: purchaseSettlementCandidatesOut,
    cache: { tags: [["purchase"], ["financialTransaction"]] },
  }),
  /**
   * On-demand Jev tie-break over candidates tied at the top deterministic
   * rank. A mutation because it is person-triggered and bills model usage,
   * not because it writes: it never allocates and invalidates nothing. Off
   * MCP on purpose, so agents keep the deterministic candidates.
   */
  suggestSettlementMatch: mutation({
    native: "Ask for an advisory ordering of equally ranked statement charges",
    input: purchaseSettlementSuggestInput,
    output: purchaseSettlementSuggestOut,
  }),
  /**
   * Whether typed allocation rows can be saved against a statement entry, and why not. The
   * allocation form's one rule (whole cents, same sign, one row per Purchase, sums to the entry),
   * so no client restates it; the write still validates on its own.
   */
  checkSettlementAllocation: query({
    native: "Validate settlement allocation rows before saving",
    transport: "post",
    input: purchaseSettlementAllocationCheckInput,
    output: purchaseSettlementAllocationCheckOut,
    cache: { tags: [] },
  }),
  orderMail: query({
    native: "Show linked order email events on native Purchase detail",
    input: purchaseOrderMailInput,
    output: purchaseOrderMailOut,
    cache: { tags: [["purchase"]] },
  }),
  products: query({
    native: "Show Product movement evidence for a Purchase",
    input: purchaseProductsInput,
    output: purchaseProductsOut,
  }),
  link: mutation({
    native: "Attach expenses to a Purchase",
    input: linkExpensesToPurchaseInput,
    output: purchaseOut,
    invalidates: ["purchase"],
  }),
  split: mutation({
    native: "Split an Expense into parts filed under its Purchase",
    input: splitExpenseInput,
    output: splitExpenseOut,
    invalidates: ["expense"],
  }),
  /**
   * The split form's starting point and its one rule: the parts to start from, and whether typed
   * parts can be saved (whole cents that add up to the original, a name each, one product part,
   * an attribution choice). Both clients consult it; `split` re-checks on write.
   */
  splitStart: query({
    native:
      "Start splitting an Expense: the starting parts and the confirmation",
    input: purchaseSplitStartInput,
    output: purchaseSplitStartOut,
    cache: { tags: [["expense"]] },
  }),
  checkSplit: query({
    native: "Validate typed split parts before saving",
    transport: "post",
    input: purchaseSplitCheckInput,
    output: purchaseSplitCheckOut,
    cache: { tags: [] },
  }),
  /** Expenses worth attaching to a Purchase for a scope and search, already worded. */
  linkExpenseCandidates: query({
    native: "List expenses that can be attached to a Purchase",
    input: purchaseLinkExpensesCandidatesInput,
    output: purchaseLinkExpensesCandidatesOut,
    cache: { tags: [["expense"], ["purchase"]] },
  }),
  /** Whether a selection can be attached and what it does to the Purchase's expense total. */
  checkLinkExpenses: query({
    native: "Validate an expense selection before attaching it to a Purchase",
    transport: "post",
    input: purchaseLinkExpensesCheckInput,
    output: purchaseLinkExpensesCheckOut,
    cache: { tags: [] },
  }),
  /** Products worth attaching to a Purchase: a search minus what is already attached. */
  linkProductCandidates: query({
    native: "List products that can be attached to a Purchase",
    input: purchaseLinkProductsCandidatesInput,
    output: purchaseLinkProductsCandidatesOut,
    cache: { tags: [["product"], ["purchase"]] },
  }),
  attachProducts: mutation({
    native: "Attach products to a Purchase",
    input: purchaseAttachProductsInput,
    output: relationMutationOut,
    invalidates: ["purchaseProduct"],
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
