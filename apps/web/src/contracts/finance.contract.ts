import {
  financialBookingInput,
  financialBookingPreview,
  financialBookingResult,
  financialBookingCorrectionInput,
  financialBookingCorrectionPreview,
  financialBookingCorrectionResult,
} from "@cubby/schemas/financial-booking";
import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionSourceOptionsOut,
  merchantVendorInference,
  merchantVendorInferenceInput,
} from "@cubby/schemas/financial-transaction";
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

export const financialTransactionContract = defineContract(
  "financialTransaction",
  {
    previewBookingCorrection: query({
      mcp: {
        omit: "deferred_capability",
        todo: "Deferred MCP agent capabilities",
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
      mcp: {
        omit: "deferred_capability",
        todo: "Deferred MCP agent capabilities",
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
        todo: "Deferred MCP agent capabilities",
      },
      input: financialBookingInput,
      output: financialBookingPreview,
      transport: "post",
      native: "Review spending before booking",
      cache: { tags: [["financialTransaction"], ["purchase"], ["expense"]] },
    }),
    commitBooking: mutation({
      mcp: {
        omit: "deferred_capability",
        todo: "Deferred MCP agent capabilities",
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
