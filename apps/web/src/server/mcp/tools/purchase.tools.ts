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
 * - **generic delete** for either entity. `deleteVendors` refuses while live
 *   purchases reference the vendor and an agent has no way to resolve that;
 *   the UI Purchase delete may null `purchaseId` on real money. The MCP-only
 *   `delete_empty_purchases` below is deliberately narrower and refuses any
 *   live Expense or FinancialTransaction reference.
 *
 * `purchase.split` / `.link` are NOT in that list anymore — they are registered
 * below as `split_expense` and `link_expenses_to_purchase`. Their refusal
 * semantics (split refuses an expense with no purchase attached) are carried in
 * full in each tool's own description, since that description is the agent's
 * error path when a refusal fires.
 *
 * `purchase.merge` and `vendor.merge` are reached through the generic
 * `merge_entity`; both declare their own prose below, which that tool composes
 * into its `entity` parameter. The vendor one is the fix for
 * `findDuplicateVendors` (Problems) candidates, which used to dead-end at
 * `preview_entity_operation` with no MCP tool that could act on the preview.
 */

import { expenseOut } from "@cubby/schemas/project";
import {
  linkExpensesToPurchaseInput,
  purchaseCreateInput,
  purchaseFilterFields,
  purchaseListResponse,
  purchaseOut,
  purchaseProductsInput,
  purchaseProductsMcpOut,
  purchaseUpdateData,
  reclassifyPurchaseDocumentInput,
  splitExpenseDelta,
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
  declareMergeableEntity,
  declareRelationEntity,
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerRouterTool,
  slimPurchase,
  slimVendor,
  WRITE_CLOSED,
} from "./_shared";

/**
 * `purchase.split` returns the created parts as a bare array; every other
 * array-shaped MCP output in this codebase wraps in `{ items }` so the
 * advertised JSON Schema is object-shaped (a top-level `z.array` has no
 * `properties` key, which trips the "advertises real JSON Schema properties"
 * regression guard in server.unit.test.ts). Mirrors `expenseBulkMcpOut` in
 * project.tools.ts.
 *
 * `originalCost`/`partsSum`/`delta` close the gap the web dialog doesn't have:
 * a human sees the "$X over/under" warning live as they type, but an MCP
 * caller only sees the finished result — so the result carries the same cue.
 * `splitExpenseDelta` is the pure computation (`@cubby/schemas/purchase`);
 * `delta` is non-zero exactly when a partial refund or a one-sided discount
 * legitimately makes the parts disagree with the original, and that is
 * expected, not an error — nothing here rejects it.
 */
const splitExpenseMcpOut = z.object({
  items: z.array(expenseOut),
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
      "partsSum minus originalCost, in dollars. A CUE, never a gate — a non-zero delta is not rejected and is not back-computed into any part's cost. Null when originalCost is null (nothing to compare against).",
    ),
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
    operations: { delete: false },
    descriptions: {
      list: "The vendor roster — every counterparty money has gone to, with website, notes, and two read-only rollups: `purchaseCount` (live purchases pointing at this vendor) and `spend` (SUM(cost) over the live expenses of those purchases — the blended net, and NEVER derived from purchase.statedTotal, which is not spend). This is the tool to start from whenever you need a `vendorId`: list_expenses, list_purchases and create_purchase all filter/write by vendor **id**, and they accept only the `VEN-` shortcode returned here. `search` matches vendor identity; related Expenses, Purchases, Products, and FinancialTransactions each expose exact-id, has/none, and terminal-name filters. Sorted by name; pass pageSize up to 100 to pull the whole roster in one call.",
      get: "Get one vendor by id: identity (name, website, notes) plus the `purchaseCount` and `spend` rollups. `spend` is SUM(cost) over the live expenses of this vendor's live purchases — never a sum of statedTotal. To see what the money actually went on, call list_expenses with this vendorId (the spend ledger) or list_purchases with it (the individual purchases).",
      create:
        'Add a vendor to the roster — identity only, no money. `name` is required; `website` and `notes` are optional and default to null. Prefer NOT calling this directly for an import: create_expense accepts `vendor` by NAME and find-or-creates both the vendor and its purchase inside the same transaction, so a one-off purchase needs no roster call at all. Reach for create_vendor when you are deliberately seeding the roster (e.g. recording a contractor before any invoice exists) or when you need `website`/`notes` set, which the name-resolution path leaves null. Check list_vendors first — the roster already holds ~114 vendors and a near-duplicate ("Amazon" vs "Amazon Business") is a real, separate row, not a typo the system will fold together.',
      delete:
        "Soft-delete vendors. REFUSES while any live Purchase still points at one — the refusal names which vendors blocked and how many purchases each still holds. Move or delete those purchases first, or merge the vendor into its keeper with merge_entity (entity=vendor) instead of deleting it.",
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
    operations: { delete: false },
    descriptions: {
      list: "List vendor purchases. A `purchase` is one vendor order, receipt, or deliberately separate purchase event, NOT an Expense or card charge. Each row returns vendor identity, order/date fields, Expense totals (the spend), the literal vendor `statedTotal`, classified documents, financial reconciliation (including `postedRefundTotal`), and computed dataQuality. `search` matches orderId OR displayLabel; `displayLabelSearch` narrows specifically to the human-entered label. Reconciliation is `refund_adjusted` when posted refunds exactly explain a lower Expense total; `mismatch` is reserved for unexplained differences. Related Expenses, FinancialTransactions, Products, and Projects each support an exact public-id filter, a has/none presence filter, and terminal-name text search; different related paths combine with AND. Start a completeness audit with dataStatus=needs_data; narrow with dataGap (one or several checks). Linked Product gaps are returned separately with the PRD- targetId and do not change the Purchase's own data status. Sorted newest purchase first.",
      get: "Get one vendor purchase by id. A `purchase` is a vendor order/receipt event, NOT an Expense or card charge. Returns vendor/order identity, literal `statedTotal`, Expense totals (the spend), classified documents, financial reconciliation (including `postedRefundTotal`), and computed dataQuality including linked Product gaps. A `refund_adjusted` reconciliation is neutral; `mismatch` needs review. Read Expenses with list_expenses and settlement evidence with list_financial_transactions, both filtered by this PUR- shortcode.",
      create:
        "Create one vendor order, receipt, or deliberately separate purchase event. This books no money: Expenses carry spend, FinancialTransactions carry settlement evidence, and `statedTotal` is always the literal vendor-printed total. `displayLabel` preserves concise human-entered ledger context and renders parenthetically after the order identity. `vendorId` is a VEN- shortcode; orderId, displayLabel, vendor date, notes, and statedTotal are optional.",
      delete:
        "Soft-delete purchases, and ONLY empty ones. Refuses any purchase still carrying live Expenses or holding settlement allocations, naming which and with how many — the UI's own delete detaches those references instead, which would silently strip real money of its provenance. Delete the linked Expenses first, and unlink or delete the linked Financial Transactions.",
      update:
        "Update vendor-side purchase identity and paperwork. Nothing here changes spend or settlement: correct spend with update_expense and settlement evidence with update_financial_transaction. `displayLabel` is concise human-entered context rendered parenthetically after the order identity; do not put it in orderId or duplicate it across Expense names. `statedTotal` must remain the literal vendor-printed total and is never summed. Also writable: vendorId, orderId, displayLabel, vendor date, notes, and document ordering/removal.",
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
      "Split ONE Expense into ≥2 Expenses on the SAME purchase — the way an aggregate spend record (a combo kit or multi-item receipt entered as one Expense) gets a real per-product cost basis instead of staying an unattributed blob. Any product in inventory whose only Expense is inside an aggregate has NO cost basis until it is split out. Each part gets its own name/cost/costType/trade/projectId/productId/productQuantity. productQuantity is SIGNED, and zero only on a negative-cost part (see create_expense); a part with a positive cost may not carry a negative quantity. Omitted notes inherit the original Expense notes; explicit null clears them for that part. The original URL, date and future state are preserved. " +
      "This REPLACES the old `(combo, saw portion)` naming convention that used to encode a split inside a single expense's name — do not invent names like that anymore; give each part its own real name instead. " +
      "Parts are expected to sum to the original expense's cost, but that is a convention, NOT a rule this tool enforces: nothing validates the sum. The response's `originalCost`/`partsSum`/`delta` are a CUE, never a gate — parts are recorded exactly as entered, and a non-zero delta is EXPECTED, not an error, whenever a partial refund or a discount applied to only one part legitimately makes the parts disagree with the original. The same gap is separately DISPLAYED as a purchase-reconciliation cue against statedTotal/expenseTotal; posted refunds that exactly explain it are classified `refund_adjusted`, other differences remain `mismatch`. " +
      "The original Expense is soft-deleted and every part is created on the SAME purchase (`purchaseId`) the original had — this only re-labels how one purchase's money is attributed; it never creates a new purchase or moves money to a different vendor. If the purchase had no `statedTotal`, one is seeded from the original expense's cost so the parts have something to reconcile against. " +
      "REFUSES when the Expense has no purchase attached (`purchaseId` is null). Call update_expense first with a `vendor` (and `orderId` if known) to give the Expense a purchase, then split it.",
    inputSchema: splitExpenseInput.shape,
    outputSchema: splitExpenseMcpOut,
    annotations: WRITE_CLOSED,
    call: async (caller, params) => {
      // Read before the split runs — the original row is soft-deleted by the
      // time `purchase.split` returns, so its cost has to be captured first.
      const original = await caller.expense.getByID({ id: params.expenseId });
      const items = await caller.purchase.split(params);
      const { originalCost, partsSum, delta } = splitExpenseDelta(
        original.cost,
        params.parts.map((part) => part.cost),
      );
      return { items, originalCost, partsSum, delta };
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

  declareMergeableEntity(
    server,
    "purchase",
    "Re-parents every Expense from the merged-away purchases onto the keeper, moves their documents and settlement links, then SOFT-DELETES them — their identity, statedTotal and filed paperwork are gone, though no Expense and no money is. For order-less singletons a backfill could not group safely. REFUSES across vendors, and REFUSES when more than one purchase in the cluster carries a non-null orderId (two order ids are two transactions, not duplicates); a loser's null orderId is fine, and its orderId is adopted when the keeper has none. This is the one merge that reports no `merged` count.",
  );

  declareMergeableEntity(
    server,
    "vendor",
    "The fix for two spellings of one vendor (`Amazon` / `amazon` / `Amazon.com`), which findDuplicateVendors (Problems) surfaces but cannot act on. Every live Purchase re-points onto the keeper; because Purchase enforces one row per (vendor, orderId), a loser purchase sharing its non-null orderId with one already on the keeper is FOLDED instead — its expenses and documents move onto the survivor purchase and the loser purchase is soft-deleted. Order-less purchases never collide. The keeper picks up website/notes/logo ONLY where it has none. Each merged-away vendor is soft-deleted and keeps its OWN `VEN-` code as a permanent tombstone: shortcodes are never reassigned, so that code will never resolve to the keeper.",
  );

  registerRouterTool(server, {
    name: "list_purchase_products",
    description:
      'List the Products one Purchase acquired. Rows come from TWO sources and `source` says which: "expense" means one of this order\'s own itemized Expenses names the product (the common case), "link" means an explicit PurchaseProduct row, and "both" means each exists for that pair. Only Expenses that ACQUIRE count — a negative Expense records an exit (sale, return, disposal), so a disposal order does not list the goods it sold. This is PROVENANCE, not money: nothing here carries an amount or quantity or appears in any spend total. The explicit link exists because an order paid in installments has Expenses with lineBasis "allocation" — a slice of a total that was never itemized, either by payment schedule (a deposit buys no particular item) or by an estimated materials/labor split — and such a row can never carry a productId. Where spend IS itemized per product (lineBasis "item_line"), the Expense\'s own productId already records it and is the better source; those pairs appear here with source "expense" and need no link. `linkAttachedAt` is when the explicit link was recorded, and is null on a source "expense" row — it is also the test for whether detach_entity has anything to remove.',
    inputSchema: purchaseProductsInput.shape,
    // `{items}`, like every other list tool — see `purchaseProductsMcpOut`.
    outputSchema: purchaseProductsMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => ({
      items: await caller.purchase.products(params),
    }),
  });

  // The prose that used to be `attach_purchase_products`' /
  // `detach_purchase_products`' own descriptions, composed into `attach_entity`
  // / `detach_entity`'s `parentId` parameter. "Provenance, not money" is the
  // whole point of this edge and must survive the collapse.
  declareRelationEntity(server, "purchase", {
    attach:
      'PUR- parent = PURCHASE PROVENANCE LINKS (`PurchaseProduct`). Records that existing Products were bought on one existing Purchase. This link is PROVENANCE, NOT MONEY: it creates, adjusts, and duplicates nothing in the ledger, carries no amount and no quantity, and must never stand in for pricing a line. It exists because an order paid in installments has Expenses with lineBasis "allocation" — a slice of a total that was never itemized — which can never carry a productId, leaving the goods with no path back to the order that bought them. Prefer setting an Expense\'s own productId whenever the spend is genuinely itemized per product; reach for this only when no Expense can hold the fact.',
    detach:
      "PUR- parent = PURCHASE PROVENANCE LINKS. Soft-deletes explicit Product links from one Purchase. The link carries no money and no quantity, so detaching touches no Expense, no inventory, and no spend total. It removes ONLY the explicit link: if one of this order's itemized Expenses also names that Product, list_purchase_products keeps returning the pair with source \"expense\" — the relationship is still recorded, by the Expense. To break that one, clear the Expense's productId instead. A pair whose `linkAttachedAt` is null has no link to remove at all.",
  });
}
