/**
 * Vendor / purchase MCP tools — the two levels ABOVE the expense ledger.
 *
 * `Vendor ──< Purchase ──< Expense`. The ledger itself (`list_expenses`,
 * `create_expense`, the bulk classifiers, `get_expense_analytics`) lives in
 * project.tools.ts; this file covers the roster of counterparties and the
 * individual vendor purchases they issue.
 *
 * ## The naming hazard
 *
 * `create_purchase` / `get_purchase` / `list_purchases` / `update_purchase`
 * USED to mean the flat ledger row that is now `expense`. Those names are reused
 * here for the purchase, and the reuse is safe only because the schemas are
 * incompatible in a way that fails LOUDLY: `purchaseCreateInput` requires
 * `vendorId` (a `VEN-` shortcode) and has no
 * `name`/`cost`/`trade`/`costType`, so a stale caller passing the old ledger
 * shape gets a zod validation error rather than a silently wrong write. The
 * descriptions below carry their weight in making that failure legible — every
 * one of the four leads with "a Purchase is one vendor order/receipt event, not an
 * Expense" and points at the `*_expense*` tool. Do not shorten them.
 *
 * ## Deliberately not exposed
 *
 * - **delete** for either entity. `deleteVendors` refuses while live purchases
 *   reference the vendor and an agent has no way to resolve that; deleting a
 *   purchase nulls `purchaseId` on real money. Both stay UI-only.
 *
 * `purchase.split` / `.link` / `.merge` are NOT in that list anymore — they are
 * registered below as `split_expense`, `link_expenses_to_purchase` and
 * `merge_purchases`. Their refusal semantics (merge refuses across vendors and
 * across two order ids, split refuses an expense with no purchase attached) are
 * carried in full in each tool's own description, since that description is the
 * agent's error path when a refusal fires.
 */

import { unsafePurchaseId, unsafeVendorId } from "@cubby/schemas/identifiers";
import { expenseOut } from "@cubby/schemas/project";
import {
  linkExpensesToPurchaseInput,
  mergePurchasesInput,
  purchaseCreateInput,
  purchaseFilterFields,
  purchaseListResponse,
  purchaseOut,
  purchaseUpdateData,
  reclassifyPurchaseDocumentInput,
  splitExpenseInput,
} from "@cubby/schemas/purchase";
import {
  vendorCreateInput,
  vendorFilterFields,
  vendorListResponse,
  vendorOut,
  vendorUpdateData,
} from "@cubby/schemas/vendor";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  registerEntityCrudToolset,
  registerRouterTool,
  slimPurchase,
  slimVendor,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

/**
 * `purchase.split` returns the created parts as a bare array; every other
 * array-shaped MCP output in this codebase wraps in `{ items }` so the
 * advertised JSON Schema is object-shaped (a top-level `z.array` has no
 * `properties` key, which trips the "advertises real JSON Schema properties"
 * regression guard in server.unit.test.ts). Mirrors `expenseBulkMcpOut` in
 * project.tools.ts.
 */
const splitExpenseMcpOut = z.object({
  items: z.array(expenseOut),
});

/**
 * `pendingImageIds` is the browser upload handshake — the widget PUTs to R2,
 * gets a PENDING image id back, and a save turns it into an attachment. An MCP
 * client has no way to mint one (its path is `attach_file`), so advertising the
 * field would only invite a fabricated uuid. `removeImageIds` / `imageOrder`
 * stay: `get_purchase` returns each document's real id, so both are actionable.
 */
const purchaseMcpCreateInput = purchaseCreateInput.omit({
  pendingImageIds: true,
});
const purchaseMcpUpdateShape = purchaseUpdateData.omit({
  pendingImageIds: true,
}).shape;

export function registerPurchaseTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "vendor",
    createInput: vendorCreateInput.shape,
    updateShape: vendorUpdateData.shape,
    filterFields: vendorFilterFields,
    mcpListOut: vendorListResponse,
    out: vendorOut,
    slim: slimVendor,
    sort: { orderBy: "name", direction: "asc" },
    // `vendor.getByID` takes the branded id as a bare scalar, not `{ id }`.
    get: (caller, id) => caller.vendor.getByID(unsafeVendorId(id)),
    operations: { delete: false },
    descriptions: {
      list: "The vendor roster — every counterparty money has gone to, with website, notes, and two read-only rollups: `purchaseCount` (live purchases pointing at this vendor) and `spend` (SUM(cost) over the live expenses of those purchases — the blended net, and NEVER derived from purchase.statedTotal, which is not spend). This is the tool to start from whenever you need a `vendorId`: list_expenses, list_purchases and create_purchase all filter/write by vendor **id**, and they accept only the `VEN-` shortcode returned here. `search` matches vendor identity; related Expenses, Purchases, Products, and FinancialTransactions each expose exact-id, has/none, and terminal-name filters. Sorted by name; pass pageSize up to 100 to pull the whole roster in one call.",
      get: "Get one vendor by id: identity (name, website, notes) plus the `purchaseCount` and `spend` rollups. `spend` is SUM(cost) over the live expenses of this vendor's live purchases — never a sum of statedTotal. To see what the money actually went on, call list_expenses with this vendorId (the spend ledger) or list_purchases with it (the individual purchases).",
      create:
        'Add a vendor to the roster — identity only, no money. `name` is required; `website` and `notes` are optional and default to null. Prefer NOT calling this directly for an import: create_expense accepts `vendor` by NAME and find-or-creates both the vendor and its purchase inside the same transaction, so a one-off purchase needs no roster call at all. Reach for create_vendor when you are deliberately seeding the roster (e.g. recording a contractor before any invoice exists) or when you need `website`/`notes` set, which the name-resolution path leaves null. Check list_vendors first — the roster already holds ~114 vendors and a near-duplicate ("Amazon" vs "Amazon Business") is a real, separate row, not a typo the system will fold together.',
      update:
        "Update a vendor's identity fields (name, website, notes). Renaming is safe: purchases and expenses reference the vendor by id, so nothing is re-keyed and no spend moves. `purchaseCount` and `spend` are read-only rollups and cannot be written. There is deliberately no delete_vendors tool — deletion refuses while live purchases still reference the vendor, and rehoming them is a UI operation.",
    },
    create: (caller, params) => caller.vendor.create(params),
  });

  registerEntityCrudToolset(server, {
    entity: "purchase",
    createInput: purchaseMcpCreateInput.shape,
    updateShape: purchaseMcpUpdateShape,
    filterFields: purchaseFilterFields,
    mcpListOut: purchaseListResponse,
    out: purchaseOut,
    slim: slimPurchase,
    sort: { orderBy: "date", direction: "desc" },
    // `purchase.getByID` takes the branded id as a bare scalar, not `{ id }`.
    get: (caller, id) => caller.purchase.getByID(unsafePurchaseId(id)),
    operations: { delete: false },
    descriptions: {
      list: "List vendor purchases. A `purchase` is one vendor order, receipt, or deliberately separate purchase event, NOT an Expense or card charge. Each row returns vendor identity, order/date fields, Expense totals (the spend), the literal vendor `statedTotal`, classified documents, financial reconciliation (including `postedRefundTotal`), and computed dataQuality. Reconciliation is `refund_adjusted` when posted refunds exactly explain a lower Expense total; `mismatch` is reserved for unexplained differences. Related Expenses, FinancialTransactions, Products, and Projects each support an exact public-id filter, a has/none presence filter, and terminal-name text search; different related paths combine with AND. Start a completeness audit with dataStatus=needs_data; narrow with dataGap (one or several Purchase/Product checks). Product gaps roll up with the PRD- targetId. Sorted newest purchase first.",
      get: "Get one vendor purchase by id. A `purchase` is a vendor order/receipt event, NOT an Expense or card charge. Returns vendor/order identity, literal `statedTotal`, Expense totals (the spend), classified documents, financial reconciliation (including `postedRefundTotal`), and computed dataQuality including linked Product gaps. A `refund_adjusted` reconciliation is neutral; `mismatch` needs review. Read Expenses with list_expenses and settlement evidence with list_financial_transactions, both filtered by this PUR- shortcode.",
      create:
        "Create one vendor order, receipt, or deliberately separate purchase event. This books no money: Expenses carry spend, FinancialTransactions carry settlement evidence, and `statedTotal` is always the literal vendor-printed total. `vendorId` is a VEN- shortcode; orderId, vendor date, notes, and statedTotal are optional.",
      update:
        "Update vendor-side purchase identity and paperwork. Nothing here changes spend or settlement: correct spend with update_expense and settlement evidence with update_financial_transaction. `statedTotal` must remain the literal vendor-printed total and is never summed. Also writable: vendorId, orderId, vendor date, notes, and document ordering/removal.",
    },
    create: (caller, params) => caller.purchase.create(params),
  });

  registerRouterTool(server, {
    name: "reclassify_purchase_document",
    description:
      "Reclassify one existing attachment on a Purchase. Primary evidence is exactly order_confirmation, sales_order, invoice, or receipt; payment receipts, credits, returns, quotes, estimates, contracts, statements, specifications, and other files remain useful but do not satisfy primary_document completeness. Returns the Purchase with freshly computed dataQuality.",
    inputSchema: reclassifyPurchaseDocumentInput.shape,
    outputSchema: purchaseOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.purchase.reclassifyDocument(params),
  });

  registerRouterTool(server, {
    name: "split_expense",
    description:
      "Split ONE Expense into ≥2 Expenses on the SAME purchase — the way an aggregate spend record (a combo kit or multi-item receipt entered as one Expense) gets a real per-product cost basis instead of staying an unattributed blob. Any product in inventory whose only Expense is inside an aggregate has NO cost basis until it is split out. Each part gets its own name/cost/costType/trade/projectId/productId (projectId/productId default to null). " +
      "This REPLACES the old `(combo, saw portion)` naming convention that used to encode a split inside a single expense's name — do not invent names like that anymore; give each part its own real name instead. " +
      "Parts are expected to sum to the original expense's cost, but that is a convention, NOT a rule this tool enforces: nothing validates the sum, and a deliberately mismatched total is DISPLAYED as a purchase-reconciliation cue against statedTotal/expenseTotal, never rejected. Posted refunds that exactly explain the gap are classified `refund_adjusted`; other differences remain `mismatch`. " +
      "The original Expense is soft-deleted and every part is created on the SAME purchase (`purchaseId`) the original had — this only re-labels how one purchase's money is attributed; it never creates a new purchase or moves money to a different vendor. If the purchase had no `statedTotal`, one is seeded from the original expense's cost so the parts have something to reconcile against. " +
      "REFUSES when the Expense has no purchase attached (`purchaseId` is null). Call update_expense first with a `vendor` (and `orderId` if known) to give the Expense a purchase, then split it.",
    inputSchema: splitExpenseInput.shape,
    outputSchema: splitExpenseMcpOut,
    annotations: WRITE_CLOSED,
    call: async (caller, params) => {
      const items = await caller.purchase.split(params);
      return { items };
    },
  });

  registerRouterTool(server, {
    name: "link_expenses_to_purchase",
    description:
      "Re-parent existing Expenses onto ONE existing purchase — e.g. one plumbing transaction that spans both rough-in and fixtures. This only rewrites `purchaseId` on the given expenses; it creates no money, changes no cost/trade/costType/project on any Expense, and leaves the target purchase's identity (vendorId/orderId/date/statedTotal/documents) untouched aside from gaining those expenses. " +
      "NOT for payment schedules: a contractor's progress payments are separate transactions and therefore separate purchases. Do not combine them just because they share a project or vendor; use the Project rollup for that view. " +
      "REFUSES when `purchaseId` does not resolve to a live purchase.",
    inputSchema: linkExpensesToPurchaseInput.shape,
    outputSchema: purchaseOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.purchase.link(params),
  });

  registerRouterTool(server, {
    name: "merge_purchases",
    description:
      "Merge one or more purchases (`mergeIds`) into a single keeper purchase (`keepId`) — for order-less singletons a backfill could not group safely. Every Expense from a merged-away purchase is re-parented onto the keeper, and each merged-away Purchase is then SOFT-DELETED; its identity, statedTotal, and filed documents are gone. This is destructive to the merged-away Purchase rows, though not to any Expense or money, so choose `keepId` deliberately. " +
      "REFUSES across vendors. REFUSES when more than one purchase involved carries a non-null `orderId` — two order ids are two transactions, not duplicates; a loser's null orderId is fine, and its orderId is adopted when the keeper has none. " +
      "There is deliberately NO inverse operation and no `splitPurchase`. Confirm the correct keeper and duplicate purchases with list_purchases/get_purchase before calling; never guess a merge.",
    inputSchema: mergePurchasesInput.shape,
    outputSchema: purchaseOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    call: (caller, params) => caller.purchase.merge(params),
  });
}
