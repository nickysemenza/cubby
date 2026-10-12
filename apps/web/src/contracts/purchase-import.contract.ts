import {
  createEmailAccuracyEvaluationInput,
  createEmailAccuracyEvaluationOut,
  listBlindEmailAccuracyItemsInput,
  listBlindEmailAccuracyItemsOut,
  gradeEmailAccuracyItemInput,
  gradeEmailAccuracyItemOut,
  getEmailAccuracyReportInput,
  emailAccuracyReport,
} from "@cubby/schemas/email-accuracy";
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
import { entityReportOut } from "@cubby/schemas/entity-report";
import {
  mailReadInput,
  mailReadOut,
  mailResolveInput,
  mailResolveOut,
  mailSearchInput,
  mailSearchOut,
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
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

// Agent- and caller-facing (MCP `purchase_import`, `mail`, `imports_read`):
// the same writers serve Pi's Mail import and a member's Claude/Codex session.
export const purchaseImportContract = defineContract("purchaseImport", {
  emailAccuracyCreate: mutation({
    input: createEmailAccuracyEvaluationInput,
    output: createEmailAccuracyEvaluationOut,
    native: "Freeze an independent Email accuracy sample",
    invalidates: ["email"],
  }),
  emailAccuracyBlind: query({
    input: listBlindEmailAccuracyItemsInput,
    output: listBlindEmailAccuracyItemsOut,
    readPolicy: "strong",
    transport: "post",
    native: "Blind Email accuracy sample",
  }),
  emailAccuracyGrade: mutation({
    input: gradeEmailAccuracyItemInput,
    output: gradeEmailAccuracyItemOut,
    native: "Record independent Email accuracy grade",
    invalidates: ["email"],
  }),
  emailAccuracyReport: query({
    input: getEmailAccuracyReportInput,
    output: emailAccuracyReport,
    readPolicy: "strong",
    transport: "post",
    native: "Weighted Email accuracy report",
  }),

  commitAcceptedReconciliation: mutation({
    input: commitAcceptedSourceOrderReconciliationInput,
    output: commitAcceptedSourceOrderReconciliationOut,
    native: "Reviewed existing Expense Product association",
    invalidates: ["expense", "product", "purchase", "runOnly"],
  }),
  correctEmailRelevance: mutation({
    input: correctEmailRelevanceInput,
    output: correctEmailRelevanceOut,
    native: "Correct reviewed Email relevance and recover its original",
    invalidates: ["email"],
  }),
  emailImport: mutation({
    input: emailImportInput,
    output: emailImportOut,
    native: "Explicit selected Email import",
    invalidates: ["email", "runOnly"],
  }),
  /** Link or dismiss one Email for one Purchase (Purchase, Vendor and Email pages). */
  emailPurchaseDecide: mutation({
    input: emailPurchaseDecisionInput,
    output: emailPurchaseDecisionOut,
    native: "Link or dismiss an Email for a Purchase",
    // Every Emails section reads the Email list, so the list tag refreshes
    // the Purchase, Vendor and account sections together.
    invalidates: ["email"],
  }),
  emailReclassify: mutation({
    input: reclassifyEmailsInput,
    output: reclassifyEmailsOut,
    native: "Reclassify selected Emails from their originals",
    invalidates: ["email", "runOnly"],
  }),
  emailPreviewRerun: mutation({
    input: emailAtChecksum,
    output: rerunEmailPreviewOut,
    native: "Rerun one Email's extraction preview",
    invalidates: ["email", "runOnly"],
  }),
  /** Member-wide accuracy as report blocks: the Emails list's Accuracy view. */
  emailAccuracyView: query({
    input: z.object({}).strict(),
    output: entityReportOut,
    readPolicy: "strong",
    mcp: {
      omit: "agent_twin",
      twin: "purchaseImport.emailAccuracyReport",
      note: "Agents read the structured report; this composes it as display blocks.",
    },
  }),
  prepareReconciliation: mutation({
    input: prepareSourceOrderReconciliationInput,
    output: prepareSourceOrderReconciliationOut,
    native: "Reviewed source-order reconciliation preview",
    invalidates: ["runOnly"],
  }),
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
