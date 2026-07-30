/**
 * Vendor / charge MCP tools — the two levels ABOVE the expense ledger.
 *
 * `Vendor ──< Purchase ──< Expense`. The ledger itself (`list_expenses`,
 * `create_expense`, the bulk classifiers, `get_expense_analytics`) lives in
 * project.tools.ts; this file covers the roster of counterparties and the
 * individual vendor charges they issue.
 *
 * ## The naming hazard
 *
 * `create_purchase` / `get_purchase` / `list_purchases` / `update_purchase`
 * USED to mean the flat ledger row that is now `expense`. Those names are reused
 * here for the charge, and the reuse is safe only because the schemas are
 * incompatible in a way that fails LOUDLY: `purchaseCreateInput` requires
 * `vendorId` (a uuid) and has no `name`/`cost`/`trade`/`costType`, so a stale
 * caller passing the old ledger shape gets a zod validation error rather than a
 * silently wrong write. The descriptions below carry their weight in making that
 * failure legible — every one of the four leads with "a purchase is a vendor
 * charge, not a line of spend" and points at the `*_expense*` tool. Do not
 * shorten them.
 *
 * ## Deliberately not exposed
 *
 * - **delete** for either entity. `deleteVendors` refuses while live charges
 *   reference the vendor and an agent has no way to resolve that; deleting a
 *   charge nulls `purchaseId` on real money. Both stay UI-only.
 * - **`purchase.split` / `.link` / `.merge`** — destructive restructuring with
 *   subtle refusal semantics (merge refuses across vendors, split replaces one
 *   expense with N). UI-only for now.
 */

import { unsafePurchaseId, unsafeVendorId } from "@cubby/schemas/identifiers";
import { expenseOut } from "@cubby/schemas/project";
import {
  purchaseCreateInput,
  purchaseFilterFields,
  purchaseListResponse,
  purchaseOut,
  purchaseUpdateData,
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
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerRouterTool,
  slimPurchase,
  slimVendor,
} from "./_shared";

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

/** `purchase.expenses` returns a bare array; MCP structured output needs an object. */
const purchaseExpensesOut = z.object({ items: z.array(expenseOut) });

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
      list: "The vendor roster — every counterparty money has gone to, with website, notes, and two read-only rollups: `purchaseCount` (live charges pointing at this vendor) and `spend` (SUM(cost) over the live expenses of those charges — the blended net, and NEVER derived from purchase.statedTotal, which is not spend). This is the tool to start from whenever you need a `vendorId`: list_expenses, list_purchases and create_purchase all filter/write by vendor **id**, and a uuid is the only form they accept. The only filter is `search`, a substring match on the vendor NAME. Sorted by name; pass pageSize up to 100 to pull the whole roster in one call.",
      get: "Get one vendor by id: identity (name, website, notes) plus the `purchaseCount` and `spend` rollups. `spend` is SUM(cost) over the live expenses of this vendor's live charges — never a sum of statedTotal. To see what the money actually went on, call list_expenses with this vendorId (the spend ledger) or list_purchases with it (the individual charges).",
      create:
        'Add a vendor to the roster — identity only, no money. `name` is required; `website` and `notes` are optional and default to null. Prefer NOT calling this directly for an import: create_expense accepts `vendor` by NAME and find-or-creates both the vendor and its charge inside the same transaction, so a one-off purchase needs no roster call at all. Reach for create_vendor when you are deliberately seeding the roster (e.g. recording a contractor before any invoice exists) or when you need `website`/`notes` set, which the name-resolution path leaves null. Check list_vendors first — the roster already holds ~114 vendors and a near-duplicate ("Amazon" vs "Amazon Business") is a real, separate row, not a typo the system will fold together.',
      update:
        "Update a vendor's identity fields (name, website, notes). Renaming is safe: charges and expenses reference the vendor by id, so nothing is re-keyed and no spend moves. `purchaseCount` and `spend` are read-only rollups and cannot be written. There is deliberately no delete_vendors tool — deletion refuses while live charges still reference the vendor, and rehoming them is a UI operation.",
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
      list: 'List vendor CHARGES: a `purchase` is ONE vendor transaction (vendorId + optional orderId + charge date), NOT a line of spend — if you want ledger rows carrying cost/trade/costType/project, use list_expenses instead. Each row returns vendorId/vendorName, orderId, date, notes, `expenseCount`, `expenseTotal` (SUM(cost) over the charge\'s live expenses — THIS is the charge\'s spend), `statedTotal` (what the paperwork itself claimed, in dollars, NEVER summed into spend), and the filed documents. Comparing statedTotal against expenseTotal is the reconciliation cue: a mismatch is a soft flag, not an error, and is often correct (a partial refund reduces a line without changing what the charge stated). Filter by vendorId (from list_vendors), orderId, search (substring on order id), dateFrom/dateTo (inclusive YYYY-MM-DD on charge date), orderIdPresenceFilter ("none" = the ~40% of charges the vendor never issued an order id for) and statedTotalPresenceFilter ("none" = charges with no stated total recorded yet, i.e. the not-yet-reconciled worklist). Sorted newest charge first.',
      get: "Get one vendor CHARGE by id: a `purchase` is ONE vendor transaction, NOT a line of spend — for a ledger line's cost/trade/costType/project use get_expense or list_expenses instead. Returns vendorId/vendorName, orderId, date, notes, `expenseCount`, `expenseTotal` (SUM(cost) over its live expenses — the charge's actual spend), `statedTotal` (the charge's own claimed total, never summed into spend, present purely to reconcile against expenseTotal), and the filed documents with their real image ids, which are what `removeImageIds` / `imageOrder` on update_purchase take. Call get_purchase_expenses with the same id to read the lines this charge is made of.",
      create:
        "Create a vendor CHARGE: a `purchase` is ONE vendor transaction, NOT a line of spend, so this books no money at all — the ledger lines that carry cost/trade/costType/project are created with create_expense. `vendorId` is required and must be a uuid from list_vendors (there is no create-by-vendor-name path on this tool); `orderId` (the vendor's own free-text order/receipt id), `date`, `notes` and `statedTotal` are optional. `statedTotal` is what the charge itself said it was, in dollars, and is NEVER summed into spend — a charge's spend is SUM(cost) over its expenses, and statedTotal exists only as a reconciliation cue against them. Usually you do NOT need this tool: create_expense accepts `vendor` by NAME plus `orderId` and find-or-creates the vendor and the charge in the same transaction. Reach for create_purchase when the charge must exist before its lines do, or to record a statedTotal create_expense cannot carry. One purchase = one vendor transaction, never a contract: a contractor's 11 progress payments are 11 purchases, and the contract-level rollup you may actually want is a `project`.",
      update:
        "Update a vendor CHARGE: a `purchase` is ONE vendor transaction, NOT a line of spend, so nothing here changes any money — to correct a cost, trade, costType or project, use update_expense on the ledger line. This is the ONLY way to set `statedTotal`, the dollar total the charge itself claimed: it is recorded for reconciliation against `expenseTotal` (SUM(cost) over the charge's live expenses) and is NEVER summed into spend, nothing back-computes a cost from it, and a mismatch is a soft flag rather than a rejected write. Also writable: vendorId (moves the whole charge and every line's attributed vendor with it), orderId, date, notes, plus `removeImageIds` to detach filed documents and `imageOrder` to reorder them (both take the image ids returned by get_purchase). To ADD a document, use attach_file, not this tool.",
    },
    create: (caller, params) => caller.purchase.create(params),
  });

  registerRouterTool(server, {
    name: "get_purchase_expenses",
    description:
      "The ledger lines of one vendor charge — the expenses whose `purchaseId` is this purchase, with their name/cost/trade/costType/project, in the same shape list_expenses returns. This is the way in: list_expenses has no purchaseId filter, and scoping by {vendorId, orderId} only works for the ~60% of charges that carry an order id. Use it after list_purchases flags a charge whose `expenseTotal` disagrees with its `statedTotal`, to see which line is wrong before fixing it with update_expense.",
    inputSchema: { id: z.string().describe("Purchase ID") },
    outputSchema: purchaseExpensesOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => ({
      items: await caller.purchase.expenses(unsafePurchaseId(params.id)),
    }),
  });
}
