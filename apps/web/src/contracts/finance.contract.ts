import {
  cashFlowProjectionInput,
  cashFlowProjectionOut,
} from "@cubby/schemas/cash-flow";
import {
  financialBookingInput,
  financialBookingPreview,
  financialBookingResult,
  financialBookingCorrectionInput,
  financialBookingCorrectionPreview,
  financialBookingCorrectionResult,
  financialConvergenceInput,
  financialConvergenceResult,
  financialSettlementAllocationInput,
} from "@cubby/schemas/financial-booking";
import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionSourceOptionsOut,
  merchantVendorInference,
  merchantVendorInferenceInput,
} from "@cubby/schemas/financial-transaction";
import {
  acceptFinancialTransferPairInput,
  acceptFinancialTransferPairOut,
} from "@cubby/schemas/household-contribution";
import { ledgerPartyShortcode, userId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

const memberLogins = z.object({
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      email: z.email(),
      ledgerParty: z
        .object({ shortcode: ledgerPartyShortcode, name: z.string() })
        .nullable(),
    }),
  ),
  parties: z.array(
    z.object({
      shortcode: ledgerPartyShortcode,
      name: z.string(),
      userId: z.string().nullable(),
    }),
  ),
});

export const ledgerPartyContract = defineContract("ledgerParty", {
  /** Every signed-in login and the member ledger party it represents. */
  memberLogins: query({
    mcp: { omit: "auth_connection" },
    input: z.null(),
    output: memberLogins,
  }),
  /** Links (or unlinks) one login to a member ledger party. */
  setMemberLogin: mutation({
    mcp: { omit: "auth_connection" },
    input: z.object({
      userId,
      ledgerParty: ledgerPartyShortcode.nullable(),
    }),
    output: memberLogins,
    invalidates: ["memberLogins"],
  }),
});

export const cashFlowContract = defineContract("cashFlow", {
  /** Forward monthly projection over Expenses and project estimates (MCP `finance_read`). */
  projection: query({
    input: cashFlowProjectionInput,
    output: cashFlowProjectionOut,
    // Scenarios are an array of objects; keep them out of a bounded URL.
    transport: "post",
    cache: { tags: [["expense"], ["project"], ["spendingCategory"]] },
  }),
});

export const financialTransactionContract = defineContract(
  "financialTransaction",
  {
    allocateSettlement: mutation({
      command: { label: "Allocate settlement", confirmation: null },
      input: financialSettlementAllocationInput,
      output: financialSettlementAllocationInput.omit({
        priorAllocations: true,
      }),
      native:
        "Save reviewed settlement without replacing a changed allocation graph",
      invalidates: ["financialTransaction", "purchase", "expense"],
    }),
    acceptTransferPair: mutation({
      command: { label: "Accept transfer pair", confirmation: null },
      input: acceptFinancialTransferPairInput,
      output: acceptFinancialTransferPairOut,
      native: "Accept a reviewed transfer pair as a Ledger Transfer",
      invalidates: ["financialTransaction", "ledgerTransfer"],
    }),
    converge: mutation({
      input: financialConvergenceInput,
      output: financialConvergenceResult,
      native: "Converge uniquely verified financial evidence",
      invalidates: ["financialTransaction", "purchase", "expense", "email"],
    }),
    bookTransaction: mutation({
      command: { label: "Book transaction", confirmation: null },
      input: financialBookingInput,
      output: financialBookingResult,
      invalidates: ["financialTransaction", "purchase", "expense"],
    }),
    previewBookingCorrection: query({
      mcp: {
        omit: "deferred_capability",
      },
      input: financialBookingCorrectionInput,
      output: financialBookingCorrectionPreview,
      transport: "post",
      native: "Review reimbursement moves and transfer corrections",
      cache: {
        tags: [
          ["financialTransaction"],
          ["purchase"],
          ["expense"],
          ["ledgerTransfer"],
        ],
      },
    }),
    commitBookingCorrection: mutation({
      command: { label: "Commit booking correction", confirmation: null },
      mcp: {
        omit: "deferred_capability",
      },
      input: financialBookingCorrectionPreview,
      output: financialBookingCorrectionResult,
      native: "Apply reviewed financial corrections atomically",
      invalidates: [
        "financialTransaction",
        "purchase",
        "expense",
        "ledgerTransfer",
      ],
    }),
    previewBooking: query({
      mcp: {
        omit: "deferred_capability",
      },
      input: financialBookingInput,
      output: financialBookingPreview,
      transport: "post",
      native: "Review spending before booking",
      cache: { tags: [["financialTransaction"], ["purchase"], ["expense"]] },
    }),
    commitBooking: mutation({
      command: { label: "Commit booking", confirmation: null },
      mcp: {
        omit: "deferred_capability",
      },
      input: financialBookingPreview,
      output: financialBookingResult,
      native: "Book reviewed spending",
      invalidates: ["financialTransaction", "purchase", "expense"],
    }),
    previewStatementImport: query({
      input: financialStatementImportPreviewInput,
      output: financialStatementImportPreviewOut,
      cache: { tags: [["financialTransaction"], ["financialAccount"]] },
    }),
    sourceOptions: query({
      mcp: { omit: "client_view" },
      input: z.null(),
      output: financialTransactionSourceOptionsOut,
    }),
    vendorInference: query({
      mcp: {
        omit: "client_view",
        note: "The booking form's vendor prefill for one merchant string; statement import previews carry the inference for real rows",
      },
      input: merchantVendorInferenceInput,
      output: merchantVendorInference,
      cache: { tags: [["financialTransaction"], ["purchase"], ["vendor"]] },
    }),
  },
);
