/**
 * Vendor / purchase MCP tools — the two levels ABOVE the expense ledger.
 *
 * `Vendor ──< Purchase ──< Expense`. CRUD belongs to the entity command; this
 * module keeps the purpose-built purchase workflows.
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
 */

import { expenseOut } from "@cubby/schemas/project";
import {
  linkExpensesToPurchaseInput,
  purchaseOut,
  purchaseProductsInput,
  reclassifyPurchaseDocumentInput,
  splitExpenseDelta,
  splitExpenseInput,
} from "@cubby/schemas/purchase";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  commitProductEnrichmentInput,
  commitProductEnrichmentOut,
  overwriteProductEnrichmentInput,
  overwriteProductEnrichmentOut,
  confirmMerchantVendorRuleInput,
  confirmMerchantVendorRuleOut,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  purchaseImportOperationStatusInput,
  purchaseImportOperationStatusOut,
  validatePurchaseImportInput,
  validatePurchaseImportOut,
} from "@cubby/schemas/purchase-import";
import { vendorCoverageInput, vendorCoverageOut } from "@cubby/schemas/vendor";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { purchaseContract } from "~/contracts/purchase.contract";
import { executeEntity } from "~/server/entity-kernel";
import { confirmMerchantVendorRule } from "~/server/purchase-import/hunts";
import {
  commitPurchaseImport,
  commitProductEnrichment,
  overwriteProductEnrichment,
  preparePurchaseImport,
  purchaseImportOperationStatus,
  validatePurchaseImport,
} from "~/server/purchase-import/import-orders";
import { getVendorCoverage } from "~/server/repo/vendor";

import { getEntityKernelContext } from "../kernel-context";
import {
  READ_ONLY_CLOSED,
  registerMcpTool,
  registerRouterTool,
  WRITE_CLOSED,
} from "./_shared";
import { fromContract, mcpItemsEnvelope } from "./contract-envelope";

/**
 * `{items}` over `purchase.split`'s own output — see `mcpItemsEnvelope`. Every
 * other array-shaped MCP output in this codebase wraps the same way, since a
 * bare array root has no JSON Schema `properties` key (trips the "advertises
 * real JSON Schema properties" regression guard in catalog schema guard).
 * Mirrors `expenseBulkMcpOut` in project.tools.ts.
 *
 * `originalCost`/`partsSum`/`delta` close the gap the web dialog doesn't have:
 * a human sees the "$X over/under" warning live as they type, but an MCP
 * caller only sees the finished result — so the result carries the same cue.
 * `splitExpenseDelta` is the pure computation (`@cubby/schemas/purchase`);
 * `delta` is non-zero exactly when a partial refund or a one-sided discount
 * legitimately makes the parts disagree with the original, and that is
 * expected, not an error — nothing here rejects it.
 */
export const splitExpenseMcpOut = mcpItemsEnvelope(
  fromContract(purchaseContract.ops.split),
).extend({
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
 * `{items}` over `purchase.products`'s own output — see `mcpItemsEnvelope`.
 */
const purchaseProductsMcpOut = mcpItemsEnvelope(
  fromContract(purchaseContract.ops.products),
);

export function registerPurchaseTools(server: McpServer) {
  registerMcpTool(server, {
    name: "overwrite_product_enrichment",
    description:
      "Propose one populated manufacturer, category, or model replacement. Every call pauses for exact typed human approval and revalidates the Product before applying.",
    inputSchema: overwriteProductEnrichmentInput,
    outputSchema: overwriteProductEnrichmentOut,
    annotations: WRITE_CLOSED,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return overwriteProductEnrichment(
        context.db,
        params,
        context.actorContext,
      );
    },
  });

  registerMcpTool(server, {
    name: "commit_product_enrichment",
    description:
      "Apply a bounded, fill-only Product enrichment to one explicit target. Price, attachments, source claims, identifier reassignment, and populated-field overwrites are forbidden.",
    inputSchema: commitProductEnrichmentInput,
    outputSchema: commitProductEnrichmentOut,
    annotations: WRITE_CLOSED,
    purchaseAgentMutationHandled: true,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return commitProductEnrichment(context.db, params, context.actorContext);
    },
  });

  registerMcpTool(server, {
    name: "validate_purchase_import",
    description:
      "Compare an immutable prepared plan to its live Purchase. This read-only validation records a target diff and never invokes the import writer, source claims, attachments, or audit repair.",
    inputSchema: validatePurchaseImportInput,
    outputSchema: validatePurchaseImportOut,
    annotations: WRITE_CLOSED,
    purchaseAgentMutationHandled: true,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return validatePurchaseImport(context.db, params, context.actorContext);
    },
  });

  registerMcpTool(server, {
    name: "confirm_purchase_merchant_vendor",
    description:
      "Confirm that one exact statement merchant descriptor belongs to a Vendor for the authenticated household member. This durable mapping enables charge-driven purchase and receipt hunts; later calls replace the mapping for that exact normalized descriptor.",
    inputSchema: confirmMerchantVendorRuleInput,
    outputSchema: confirmMerchantVendorRuleOut,
    annotations: WRITE_CLOSED,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return confirmMerchantVendorRule(
        context.db,
        params,
        context.actorContext,
      );
    },
  });

  registerMcpTool(server, {
    name: "prepare_purchase_import",
    description:
      "Persist an immutable proposed purchase import for the authenticated run. Returns stable order and line ids plus existing Product candidates. This bounded preparation never writes Purchases, Expenses, or Products and does not require open-world mutation approval.",
    inputSchema: preparePurchaseImportInput,
    outputSchema: preparePurchaseImportOut,
    annotations: WRITE_CLOSED,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return preparePurchaseImport(context.db, params, context.actorContext);
    },
  });

  registerMcpTool(server, {
    name: "commit_purchase_import",
    description:
      "Commit one exact previously prepared purchase import. Every principal line maps to an existing Product shortcode, an explicit new Product, or unresolved. Unresolved lines create a finding and stop the run for review; they never create a speculative Product. This bounded commit is replay-safe, rechecks targets and evidence, and does not require open-world mutation approval.",
    inputSchema: commitPurchaseImportInput,
    outputSchema: commitPurchaseImportOut,
    annotations: WRITE_CLOSED,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return commitPurchaseImport(context.db, params, context.actorContext);
    },
  });

  registerMcpTool(server, {
    name: "purchase_import_operation_status",
    description:
      "Read the durable status and original result of one stable purchase-import operation id. Use this after interruption instead of inventing a new id or blindly repeating a write.",
    inputSchema: purchaseImportOperationStatusInput,
    outputSchema: purchaseImportOperationStatusOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) => {
      const context = getEntityKernelContext(extra);
      return purchaseImportOperationStatus(
        context.db,
        params,
        context.actorContext,
      );
    },
  });

  registerMcpTool(server, {
    name: "get_vendor_coverage",
    description:
      "Return vendor identity, its latest live purchase date overall, and sorted unique non-null order IDs from an inclusive date range.",
    inputSchema: vendorCoverageInput,
    outputSchema: vendorCoverageOut,
    annotations: READ_ONLY_CLOSED,
    handler: (params, extra) =>
      getVendorCoverage(getEntityKernelContext(extra).readDb, params),
  });

  registerRouterTool(server, {
    name: "reclassify_purchase_document",
    description:
      "Reclassify one existing attachment on a Purchase. Primary evidence is exactly order_confirmation, sales_order, invoice, or receipt; payment receipts, credits, returns, quotes, estimates, contracts, statements, specifications, and other files remain useful but do not satisfy primary_document completeness. Returns the Purchase with freshly computed dataQuality.",
    inputSchema: reclassifyPurchaseDocumentInput,
    outputSchema: purchaseOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.purchase.reclassifyDocument(params),
  });

  registerRouterTool(server, {
    name: "split_expense",
    description:
      "Split ONE Expense into 2–100 Expenses on the SAME purchase — the way an aggregate spend record (a combo kit or multi-item receipt entered as one Expense) gets a real per-product cost basis instead of staying an unattributed blob. Any product in inventory whose only Expense is inside an aggregate has NO cost basis until it is split out. Each part gets its own name/cost/costType/trade/projectId/productId/productQuantity. productQuantity is SIGNED, and zero only on a negative-cost part. Omitted notes inherit the original Expense notes; explicit null clears them for that part. The original URL, date and future state are preserved. " +
      "This REPLACES the old `(combo, saw portion)` naming convention that used to encode a split inside a single expense's name — do not invent names like that anymore; give each part its own real name instead. " +
      "Parts are expected to sum to the original expense's cost, but that is a convention, NOT a rule this tool enforces: nothing validates the sum. The response's `originalCost`/`partsSum`/`delta` are a CUE, never a gate — parts are recorded exactly as entered, and a non-zero delta is EXPECTED, not an error, whenever a partial refund or a discount applied to only one part legitimately makes the parts disagree with the original. The same gap is separately DISPLAYED as a purchase-reconciliation cue against statedTotal/expenseTotal; posted refunds that exactly explain it are classified `refund_adjusted`, other differences remain `mismatch`. " +
      "The original Expense is soft-deleted and every part is created on the SAME purchase (`purchaseId`) the original had — this only re-labels how one purchase's money is attributed; it never creates a new purchase or moves money to a different vendor. If the purchase had no `statedTotal`, one is seeded from the original expense's cost so the parts have something to reconcile against. " +
      "REFUSES when the Expense has no purchase attached (`purchaseId` is null). Use entity update(expense) with a `vendor` (and `orderId` if known) to give the Expense a purchase, then split it.",
    inputSchema: splitExpenseInput,
    outputSchema: splitExpenseMcpOut,
    annotations: WRITE_CLOSED,
    call: async (caller, params, context) => {
      if (!context) {
        throw new Error("Authenticated entity-kernel context is missing");
      }
      // Read before the split runs — the original row is soft-deleted by the
      // time `purchase.split` returns, so its cost has to be captured first.
      const original = await executeEntity(context, {
        action: "get",
        entity: "expense",
        id: params.expenseId,
        missing: "error",
      });
      if (original.action !== "get" || !original.item) {
        throw new Error("Entity kernel returned the wrong expense detail");
      }
      const items = await caller.purchase.split(params);
      const { originalCost, partsSum, delta } = splitExpenseDelta(
        expenseOut.parse(original.item).cost,
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
    inputSchema: linkExpensesToPurchaseInput,
    outputSchema: purchaseOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.purchase.link(params),
  });

  registerRouterTool(server, {
    name: "list_purchase_products",
    description:
      'List the Products one Purchase acquired. Rows come from TWO sources and `source` says which: "expense" means one of this order\'s own itemized Expenses names the product (the common case), "link" means an explicit PurchaseProduct row, and "both" means each exists for that pair. Only Expenses that ACQUIRE count — a negative Expense records an exit (sale, return, disposal), so a disposal order does not list the goods it sold. This is PROVENANCE, not money: nothing here carries an amount or quantity or appears in any spend total. The explicit link exists because an order paid in installments has Expenses with lineBasis "allocation" — a slice of a total that was never itemized, either by payment schedule (a deposit buys no particular item) or by an estimated materials/labor split — and such a row can never carry a productId. Where spend IS itemized per product (lineBasis "item_line"), the Expense\'s own productId already records it and is the better source; those pairs appear here with source "expense" and need no link. `linkAttachedAt` is when the explicit link was recorded, and is null on a source "expense" row — it is also the test for whether detach_entity has anything to remove.',
    inputSchema: purchaseProductsInput,
    // `{items}`, like every other list tool — see `purchaseProductsMcpOut`.
    outputSchema: purchaseProductsMcpOut,
    annotations: READ_ONLY_CLOSED,
    call: async (caller, params) => ({
      items: await caller.purchase.products(params),
    }),
  });
}
