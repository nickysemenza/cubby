import {
  emailAtChecksum,
  emailImportInput,
  emailPurchaseDecisionInput,
  emailPurchaseDecisionOut,
  emailImportOut,
  correctEmailRelevanceInput,
  correctEmailRelevanceOut,
  reclassifyEmailsInput,
  reclassifyEmailsOut,
  rerunEmailPreviewOut,
} from "@cubby/schemas/email-actions";
import {
  mailImportOutcomesInput,
  mailImportOutcomesOut,
} from "@cubby/schemas/mail-import-outcome";
import {
  mailReadInput,
  mailReadOut,
  mailResolveInput,
  mailResolveOut,
  mailSearchInput,
  mailSearchOut,
  mailTriagePreviewInput,
  mailTriagePreviewOut,
} from "@cubby/schemas/mailbox-research";
import {
  commitAcceptedSourceOrderReconciliationInput,
  commitAcceptedSourceOrderReconciliationOut,
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  confirmMerchantVendorRuleInput,
  confirmMerchantVendorRuleOut,
  importOperationStatusInput,
  importOperationStatusOut,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  prepareSourceOrderReconciliationInput,
  prepareSourceOrderReconciliationOut,
} from "@cubby/schemas/purchase-import";

import { defineContract, mutation, query } from "~/contracts/define";

// Agent- and caller-facing (MCP `purchase_import`, `mail`, `imports_read`):
// the same writers serve Pi's Mail import and a member's Claude/Codex session.
export const purchaseImportContract = defineContract("purchaseImport", {
  commitAcceptedReconciliation: mutation({
    input: commitAcceptedSourceOrderReconciliationInput,
    output: commitAcceptedSourceOrderReconciliationOut,
    native: "Reviewed existing Expense Product association",
    invalidates: ["expense", "product", "purchase", "runOnly"],
  }),
  correctEmailRelevance: mutation({
    command: { label: "Correct relevance", confirmation: null },
    input: correctEmailRelevanceInput,
    output: correctEmailRelevanceOut,
    native: "Correct reviewed Email relevance and recover its original",
    invalidates: ["email"],
  }),
  emailImport: mutation({
    command: {
      label: "Import Email",
      confirmation: null,
      runIdsPath: "runIds",
    },
    input: emailImportInput,
    output: emailImportOut,
    native: "Explicit selected Email import",
    invalidates: ["email", "runOnly"],
  }),
  /** Link or dismiss one Email for one Purchase (Purchase, Vendor and Email pages). */
  emailPurchaseDecide: mutation({
    command: { label: "Update Purchase link", confirmation: null },
    input: emailPurchaseDecisionInput,
    output: emailPurchaseDecisionOut,
    native: "Link or dismiss an Email for a Purchase",
    // Every Emails section reads the Email list, so the list tag refreshes
    // the Purchase, Vendor and account sections together.
    invalidates: ["email"],
  }),
  emailReclassify: mutation({
    command: {
      label: "Reclassify Email",
      confirmation: null,
      runIdsPath: "runIds",
    },
    input: reclassifyEmailsInput,
    output: reclassifyEmailsOut,
    native: "Reclassify selected Emails from their originals",
    invalidates: ["email", "runOnly"],
  }),
  emailPreviewRerun: mutation({
    command: {
      label: "Rerun preview",
      confirmation: null,
      runIdsPath: "runId",
    },
    input: emailAtChecksum,
    output: rerunEmailPreviewOut,
    native: "Rerun one Email's extraction preview",
    invalidates: ["email", "runOnly"],
  }),
  prepareReconciliation: mutation({
    input: prepareSourceOrderReconciliationInput,
    output: prepareSourceOrderReconciliationOut,
    native: "Reviewed source-order reconciliation preview",
    invalidates: ["runOnly"],
  }),
  /** Persist an immutable proposed import; writes no Purchase, Expense, or Product. */
  prepare: mutation({
    input: preparePurchaseImportInput,
    output: preparePurchaseImportOut,
  }),
  /** Commit one exact prepared import; replay-safe. */
  commit: mutation({
    input: commitPurchaseImportInput,
    output: commitPurchaseImportOut,
    invalidates: ["purchase"],
  }),
  operationStatus: query({
    input: importOperationStatusInput,
    output: importOperationStatusOut,
  }),
  confirmMerchantVendor: mutation({
    input: confirmMerchantVendorRuleInput,
    output: confirmMerchantVendorRuleOut,
  }),
  /** Read one retained Email, optionally one attachment's original bytes. */
  mailImportOutcomes: query({
    input: mailImportOutcomesInput,
    output: mailImportOutcomesOut,
    readPolicy: "strong",
    transport: "post",
    native: "Read immutable Mail import outcome history",
  }),
  mailRead: query({
    input: mailReadInput,
    output: mailReadOut,
  }),
  /** Full classification preview from Gmail, including exception-only Luna; no publication. */
  mailTriagePreview: query({
    readPolicy: "strong",
    input: mailTriagePreviewInput,
    output: mailTriagePreviewOut,
  }),
  /** Scoped live Gmail search for a missing original. */
  mailSearch: mutation({
    input: mailSearchInput,
    output: mailSearchOut,
  }),
  /** Record what one retained Email means for the member's Purchases. */
  mailResolve: mutation({
    input: mailResolveInput,
    output: mailResolveOut,
    invalidates: ["purchase"],
  }),
});
