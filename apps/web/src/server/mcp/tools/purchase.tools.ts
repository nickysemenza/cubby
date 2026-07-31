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
 * `vendorId` (a `VEN-` shortcode) and has no
 * `name`/`cost`/`trade`/`costType`, so a stale caller passing the old ledger
 * shape gets a zod validation error rather than a silently wrong write. The
 * descriptions below carry their weight in making that failure legible — every
 * one of the four leads with "a purchase is a vendor charge, not a line of
 * spend" and points at the `*_expense*` tool. Do not shorten them.
 *
 * ## Deliberately not exposed
 *
 * - **delete** for either entity. `deleteVendors` refuses while live charges
 *   reference the vendor and an agent has no way to resolve that; deleting a
 *   charge nulls `purchaseId` on real money. Both stay UI-only.
 *
 * `purchase.split` / `.link` / `.merge` are NOT in that list anymore — they are
 * registered below as `split_expense`, `link_expenses_to_purchase` and
 * `merge_purchases`. Their refusal semantics (merge refuses across vendors and
 * across two order ids, split refuses an expense with no charge attached) are
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
      list: "The vendor roster — every counterparty money has gone to, with website, notes, and two read-only rollups: `purchaseCount` (live charges pointing at this vendor) and `spend` (SUM(cost) over the live expenses of those charges — the blended net, and NEVER derived from purchase.statedTotal, which is not spend). This is the tool to start from whenever you need a `vendorId`: list_expenses, list_purchases and create_purchase all filter/write by vendor **id**, and they accept only the `VEN-` shortcode returned here. The only filter is `search`, a substring match on the vendor NAME. Sorted by name; pass pageSize up to 100 to pull the whole roster in one call.",
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
      list: "List vendor CHARGES: a `purchase` is ONE vendor transaction (vendorId + optional orderId + charge date), NOT a line of spend — if you want ledger rows carrying cost/trade/costType/project, use list_expenses instead. Each row returns vendorId/vendorName, orderId, date, notes, `expenseCount`, `unpricedExpenseCount`, `expenseTotal` (SUM(cost) over the charge's live expenses — THIS is the charge's spend), `documentCount`, `statedTotal` (what the paperwork itself claimed, in dollars, NEVER summed into spend), and the filed documents. Comparing statedTotal against expenseTotal is the reconciliation cue: a mismatch is a soft flag, not an error, and is often correct. Filter by vendorId, exact orderId, search (substring on order id), dateFrom/dateTo, orderIdPresenceFilter, statedTotalPresenceFilter, lineStatus (`empty`/`unpriced`/`priced`, several values OR), reconciliation (`unknown`/`match`/`mismatch`, several values OR), documentPresenceFilter, and inclusive expenseTotalMin/expenseTotalMax. Amount bounds only include charges with at least one priced line, so empty or wholly-unpriced charges do not read as credits. Sorted newest charge first.",
      get: "Get one vendor CHARGE by id: a `purchase` is ONE vendor transaction, NOT a line of spend — for a ledger line's cost/trade/costType/project use get_expense or list_expenses instead. Returns vendorId/vendorName, orderId, date, notes, `expenseCount`, `unpricedExpenseCount`, `expenseTotal` (SUM(cost) over its live expenses — the charge's actual spend), `documentCount`, `statedTotal` (the charge's own claimed total, never summed into spend, present purely to reconcile against expenseTotal), and the filed documents with their real image ids, which are what `removeImageIds` / `imageOrder` on update_purchase take. To read the individual ledger lines this charge is made of, call list_expenses filtered by this charge's id (purchaseId) — the exact scope, needing no vendorId/orderId cross-reference.",
      create:
        "Create a vendor CHARGE: a `purchase` is ONE vendor transaction, NOT a line of spend, so this books no money at all — the ledger lines that carry cost/trade/costType/project are created with create_expense. `vendorId` is required and must be the `VEN-` shortcode returned by list_vendors (there is no create-by-vendor-name path on this tool); `orderId` (the vendor's own free-text order/receipt id), `date`, `notes` and `statedTotal` are optional. `statedTotal` is what the charge itself said it was, in dollars, and is NEVER summed into spend — a charge's spend is SUM(cost) over its expenses, and statedTotal exists only as a reconciliation cue against them. Usually you do NOT need this tool: create_expense accepts `vendor` by NAME plus `orderId` and find-or-creates the vendor and the charge in the same transaction. Reach for create_purchase when the charge must exist before its lines do, or to record a statedTotal create_expense cannot carry. One purchase = one vendor transaction, never a contract: a contractor's 11 progress payments are 11 purchases, and the contract-level rollup you may actually want is a `project`.",
      update:
        "Update a vendor CHARGE: a `purchase` is ONE vendor transaction, NOT a line of spend, so nothing here changes any money — to correct a cost, trade, costType or project, use update_expense on the ledger line. This is the ONLY way to set `statedTotal`, the dollar total the charge itself claimed: it is recorded for reconciliation against `expenseTotal` (SUM(cost) over the charge's live expenses) and is NEVER summed into spend, nothing back-computes a cost from it, and a mismatch is a soft flag rather than a rejected write. Also writable: vendorId (moves the whole charge and every line's attributed vendor with it), orderId, date, notes, plus `removeImageIds` to detach filed documents and `imageOrder` to reorder them (both take the image ids returned by get_purchase). To ADD a document, use attach_file, not this tool.",
    },
    create: (caller, params) => caller.purchase.create(params),
  });

  registerRouterTool(server, {
    name: "split_expense",
    description:
      "Split ONE expense into ≥2 parts on the SAME charge — the way an aggregate ledger row (a combo kit, a multi-line receipt entered as one expense) gets a real per-product cost basis instead of staying an unattributed blob. Any product in inventory whose only expense is inside an aggregate has NO cost basis at all until it is split out. Each part gets its own name/cost/costType/trade/projectId/productId (projectId/productId default to null) — a combo-kit line can become a `tools` part with one productId and a `materials` part with another. " +
      "This REPLACES the old `(combo, saw portion)` naming convention that used to encode a split inside a single expense's name — do not invent names like that anymore; give each part its own real name instead. " +
      "Parts are expected to sum to the original expense's cost, but that is a convention, NOT a rule this tool enforces: nothing here validates the sum, and a deliberately mismatched total is DISPLAYED (as a purchase-reconciliation mismatch against the charge's statedTotal/expenseTotal), never rejected. " +
      "The original expense is soft-deleted and every part is created on the SAME charge (`purchaseId`) the original had — this only re-labels how one existing charge's money is attributed; it never creates a new charge and never moves money to a different vendor. If that charge had no `statedTotal` yet, one is seeded from the original expense's cost so the parts have something to reconcile against; if it already had one, it is left alone. " +
      "REFUSES when the expense has no charge attached (`purchaseId` is null) — there is nothing to attach the parts to and nothing here can invent a vendor. Call update_expense first with a `vendor` (and `orderId` if known) to give the expense a charge, then split it.",
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
      "Re-parent existing expenses onto ONE existing charge (purchase) — e.g. one plumbing invoice that legitimately spans both rough-in and fixtures: link both expense lines to the single charge that paid for both. This only rewrites `purchaseId` on the given expenses; it creates no money, changes no cost/trade/costType/project on any expense, and leaves the target charge's own identity (vendorId/orderId/date/statedTotal/documents) untouched aside from gaining these lines. " +
      "NOT for payment schedules: a contractor's progress payments (e.g. 11 payments on one job) are 11 REAL, separate transactions and therefore 11 separate purchases — do not link them onto one charge just because they share a project or a vendor. The contract-level rollup across those payments already exists and is a `project`, not a merged purchase; use list_expenses/list_purchases filtered by projectId, or get_project_budget, for that view. " +
      "REFUSES when `purchaseId` does not resolve to a live (non-deleted) charge.",
    inputSchema: linkExpensesToPurchaseInput.shape,
    outputSchema: purchaseOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.purchase.link(params),
  });

  registerRouterTool(server, {
    name: "merge_purchases",
    description:
      "Merge one or more purchase CHARGES (`mergeIds`) into a single keeper charge (`keepId`) — for the order-less singletons a backfill could not group (grouping by vendor+date alone would have falsely merged unrelated charges). Every expense that belonged to a merged-away charge is re-parented onto the keeper, and each merged-away charge is then SOFT-DELETED — its own identity, statedTotal and filed documents are gone once merged; only its expenses survive, by moving to the keeper. This is genuinely destructive to the merged-away purchase rows (not to any expense or money), so choose `keepId` deliberately before calling. " +
      "REFUSES across vendors — merging charges from two different vendors would silently rewrite who was paid, and this tool only groups charges that already share one vendor; it never corrects a mistaken vendor. REFUSES when more than one of the charges involved (keeper included) carries a non-null `orderId` — two real order ids are two real transactions, not a duplicate to fold together; a loser's null orderId is fine, and a loser's own orderId is adopted by the keeper when the keeper has none. " +
      "There is deliberately NO inverse operation — no `splitPurchase` exists, because one order is one charge by construction, so a merge cannot be undone by calling this tool differently. Because of that irreversibility, this is a user action: confirm the correct `keepId` (and which charges are really duplicates of it, e.g. via list_purchases/get_purchase) before calling — never guess a merge on your own initiative.",
    inputSchema: mergePurchasesInput.shape,
    outputSchema: purchaseOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    call: (caller, params) => caller.purchase.merge(params),
  });
}
