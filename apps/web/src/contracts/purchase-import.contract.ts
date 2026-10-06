import {
  applyValidationCorrectionsInput,
  applyValidationCorrectionsOut,
  captureEnrichmentPageInput,
  captureEnrichmentPageOut,
  commitProductEnrichmentInput,
  commitProductEnrichmentOut,
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  confirmMerchantVendorRuleInput,
  confirmMerchantVendorRuleOut,
  importOperationStatusInput,
  importOperationStatusOut,
  initiateRunEvidenceUploadInput,
  initiateRunEvidenceUploadOut,
  listReceiptHuntsInput,
  listReceiptHuntsOut,
  overwriteProductEnrichmentInput,
  overwriteProductEnrichmentOut,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  submitReceiptEvidenceInput,
  submitReceiptEvidenceOut,
  validatePurchaseImportInput,
  validatePurchaseImportOut,
} from "@cubby/schemas/purchase-import";

import { defineContract, mutation, query } from "~/contracts/define";

export const purchaseImportContract = defineContract("purchaseImport", {
  initiateRunEvidenceUpload: mutation({
    mcp: {
      omit: "agent_twin",
      twin: "purchaseImport.captureEnrichmentPage",
      note: "The Mac browser's upload transport, which trusts client metadata; an MCP agent has the server fetch and derive the page instead",
    },
    input: initiateRunEvidenceUploadInput,
    output: initiateRunEvidenceUploadOut,
    native:
      "Stage an immutable run-scoped purchase validation or enrichment evidence upload",
  }),
  listReceiptHunts: query({
    mcp: {
      omit: "human_approval",
      note: "Receipt hunts wait on user-confirmed photos",
    },
    input: listReceiptHuntsInput,
    output: listReceiptHuntsOut,
    native: "List receipt hunts awaiting user-confirmed photo evidence",
    cache: { tags: [] },
  }),
  submitReceiptEvidence: mutation({
    mcp: { omit: "human_approval" },
    input: submitReceiptEvidenceInput,
    output: submitReceiptEvidenceOut,
    native: "Submit a user-confirmed receipt photo for purchase import",
  }),
  applyValidationCorrections: mutation({
    mcp: {
      omit: "human_approval",
      note: "A person applies a reviewed subset of a validation diff; agents only propose",
    },
    input: applyValidationCorrectionsInput,
    output: applyValidationCorrectionsOut,
    native: "Apply a reviewed subset of purchase-validation corrections",
    invalidates: ["purchase", "expense", "runOnly"],
  }),
  // Agent-facing (MCP `purchase_import`, `product_enrichment`, `imports_read`):
  // the purchase agent's bounded writers, off the HTTP API.
  /** Persist an immutable proposed import; writes no Purchase, Expense, or Product. */
  prepare: mutation({
    http: false,
    input: preparePurchaseImportInput,
    output: preparePurchaseImportOut,
  }),
  /** Compare a prepared plan to its live Purchase and record the diff. */
  validate: mutation({
    http: false,
    input: validatePurchaseImportInput,
    output: validatePurchaseImportOut,
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
  /** Bounded, fill-only Product enrichment of one explicit target. */
  commitProductEnrichment: mutation({
    http: false,
    input: commitProductEnrichmentInput,
    output: commitProductEnrichmentOut,
    invalidates: ["product"],
  }),
  /**
   * Fetch one vendor product page for a caller-owned enrichment run and retain
   * it as `http_capture` evidence with server-derived proof metadata.
   */
  captureEnrichmentPage: mutation({
    http: false,
    input: captureEnrichmentPageInput,
    output: captureEnrichmentPageOut,
    invalidates: ["runOnly"],
  }),
  /** Propose one populated-field replacement; pauses for exact human approval. */
  overwriteProductEnrichment: mutation({
    http: false,
    input: overwriteProductEnrichmentInput,
    output: overwriteProductEnrichmentOut,
    invalidates: ["product"],
  }),
});
