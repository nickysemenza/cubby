import { relationMutationOut } from "@cubby/schemas/common";
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

export const purchaseContract = defineContract(
  "purchase",
  {
    settlementCandidates: query({
      exposure: "capability",
      description:
        "Rank possible Purchase matches for the supplied settlement evidence. This is read-only; confirm the paperwork and transaction before allocating settlement.",
      input: purchaseSettlementCandidatesInput,
      output: purchaseSettlementCandidatesOut,
      cache: { tags: [["purchase"], ["financialTransaction"]] },
    }),
    /**
     * On-demand the decision model tie-break over candidates tied at the top deterministic
     * rank. A mutation because it is person-triggered and bills model usage,
     * not because it writes: it never allocates and invalidates nothing.
     */
    suggestSettlementMatch: mutation({
      note: "A person asks for a tie-break; agents keep the deterministic candidates",
      input: purchaseSettlementSuggestInput,
      output: purchaseSettlementSuggestOut,
    }),
    /**
     * Whether typed allocation rows can be saved against a statement entry, and why not. The
     * allocation form's one rule (whole cents, same sign, one row per Purchase, sums to the entry),
     * so no client restates it; the write still validates on its own.
     */
    checkSettlementAllocation: query({
      note: "Allocation form check; the write validates on its own",
      input: purchaseSettlementAllocationCheckInput,
      output: purchaseSettlementAllocationCheckOut,
      cache: { tags: [] },
    }),
    link: mutation({
      exposure: "capability",
      description:
        "Re-parent existing Expenses onto ONE existing purchase — e.g. one plumbing transaction that spans both rough-in and fixtures. Only rewrites `purchaseId` on the given expenses: no cost/trade/costType/project changes, and the target purchase's identity (vendorId/orderId/date/statedTotal/documents) stays untouched aside from gaining those expenses. NOT for payment schedules: a contractor's progress payments are separate transactions and therefore separate purchases; use the Project rollup for that view. Refuses when `purchaseId` is not a live purchase.",
      command: { label: "Attach expenses", confirmation: null },
      input: linkExpensesToPurchaseInput,
      output: purchaseOut,
      invalidates: ["purchase"],
    }),
    split: mutation({
      command: { label: "Split expense", confirmation: null },
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
      input: purchaseSplitStartInput,
      output: purchaseSplitStartOut,
      cache: { tags: [["expense"]] },
    }),
    checkSplit: query({
      input: purchaseSplitCheckInput,
      output: purchaseSplitCheckOut,
      cache: { tags: [] },
    }),
    /** Expenses worth attaching to a Purchase for a scope and search, already worded. */
    linkExpenseCandidates: query({
      input: purchaseLinkExpensesCandidatesInput,
      output: purchaseLinkExpensesCandidatesOut,
      cache: { tags: [["expense"], ["purchase"]] },
    }),
    /** Whether a selection can be attached and what it does to the Purchase's expense total. */
    checkLinkExpenses: query({
      input: purchaseLinkExpensesCheckInput,
      output: purchaseLinkExpensesCheckOut,
      cache: { tags: [] },
    }),
    /** Products worth attaching to a Purchase: a search minus what is already attached. */
    linkProductCandidates: query({
      input: purchaseLinkProductsCandidatesInput,
      output: purchaseLinkProductsCandidatesOut,
      cache: { tags: [["product"], ["purchase"]] },
    }),
    attachProducts: mutation({
      note: "entity.link on purchase products",
      command: { label: "Attach products", confirmation: null },
      input: purchaseAttachProductsInput,
      output: relationMutationOut,
      invalidates: ["purchaseProduct"],
    }),
    // Agent-facing (MCP `expenses`, `purchase_import`).
    /** `split` plus the conservation check an agent confirms before moving on. */
    splitWithDelta: mutation({
      exposure: "capability",
      description:
        "Split ONE Expense into 2–100 Expenses on the SAME purchase — how an aggregate record (a combo kit or multi-item receipt entered as one Expense) gets a real per-product cost basis; a product whose only Expense is inside an aggregate has NO cost basis until it is split out. Each part gets its own name/cost/costType/trade/projectId/productId/productQuantity; productQuantity is SIGNED, and zero only on a negative-cost part. Omitted notes inherit the original's; explicit null clears them for that part. URL, date and future state are preserved. Give each part its own real name — never the old `(combo, saw portion)` naming convention. " +
        "When the original has a recorded cost, the parts must sum to it exactly or the split is refused without replacing the original; record a purchase-level discount or refund as its own Expense instead. The response confirms `originalCost`, `partsSum`, and a zero `delta` (null for an unpriced original). The original is soft-deleted and every part lands on its `purchaseId`; with no `statedTotal`, one is seeded from the original's cost. Refuses when the Expense has no purchase — entity.update(expense) with a `vendor` (and `orderId` if known) first.",
      command: { label: "Split expense", confirmation: null },
      input: splitExpenseInput,
      output: splitExpenseWithDeltaOut,
      invalidates: ["expense"],
    }),
    reclassifyDocument: mutation({
      exposure: "capability",
      description:
        "Reclassify one existing attachment on a Purchase. Primary evidence is exactly order_confirmation, sales_order, invoice, or receipt; payment receipts, credits, returns, quotes, estimates, contracts, statements, specifications, and other files stay useful but do not make the Purchase's itemization expected. Returns the Purchase with freshly computed dataQuality.",
      input: reclassifyPurchaseDocumentInput,
      output: purchaseOut,
      invalidates: ["purchase"],
    }),
  },
  { exposure: "view", mcpToolGroup: "expenses" },
);
