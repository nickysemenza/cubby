import {
  mailReadInput,
  mailReadOut,
  mailResolveInput,
  mailResolveOut,
  mailSearchInput,
  mailSearchOut,
} from "@cubby/schemas/mailbox-research";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  confirmMerchantVendorRuleInput,
  confirmMerchantVendorRuleOut,
  importOperationStatusInput,
  importOperationStatusOut,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
} from "@cubby/schemas/purchase-import";

import { defineContract, mutation, query } from "~/contracts/define";

// Agent- and caller-facing (MCP `purchase_import`, `mail`, `imports_read`):
// the same writers serve Pi's Mail import and a member's Claude/Codex session.
export const purchaseImportContract = defineContract("purchaseImport", {
  /** Persist an immutable proposed import; writes no Purchase, Expense, or Product. */
  prepare: mutation({
    http: false,
    input: preparePurchaseImportInput,
    output: preparePurchaseImportOut,
  }),
  /** Commit one exact prepared import; replay-safe. */
  commit: mutation({
    http: false,
    input: commitPurchaseImportInput,
    output: commitPurchaseImportOut,
    invalidates: ["purchase"],
  }),
  operationStatus: query({
    http: false,
    input: importOperationStatusInput,
    output: importOperationStatusOut,
  }),
  confirmMerchantVendor: mutation({
    http: false,
    input: confirmMerchantVendorRuleInput,
    output: confirmMerchantVendorRuleOut,
  }),
  /** Read one retained Email, optionally one attachment's original bytes. */
  mailRead: query({
    http: false,
    input: mailReadInput,
    output: mailReadOut,
  }),
  /** Scoped live Gmail search for a missing original. */
  mailSearch: mutation({
    http: false,
    input: mailSearchInput,
    output: mailSearchOut,
  }),
  /** Record what one retained Email means for the member's Purchases. */
  mailResolve: mutation({
    http: false,
    input: mailResolveInput,
    output: mailResolveOut,
    invalidates: ["purchase"],
  }),
});
