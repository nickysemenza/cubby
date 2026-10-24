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
  financialTransactionImportPreviewInput,
  financialTransactionImportPreviewOut,
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

export const ledgerPartyContract = defineContract(
  "ledgerParty",
  {
    /** Every signed-in login and the member ledger party it represents. */
    memberLogins: query({
      input: z.null(),
      output: memberLogins,
    }),
    /** Links (or unlinks) one login to a member ledger party. */
    setMemberLogin: mutation({
      input: z.object({
        userId,
        ledgerParty: ledgerPartyShortcode.nullable(),
      }),
      output: memberLogins,
      invalidates: ["memberLogins"],
    }),
  },
  { exposure: "internal" },
);

export const cashFlowContract = defineContract(
  "cashFlow",
  {
    /** Forward monthly projection over Expenses and project estimates (MCP `finance_read`). */
    projection: query({
      description:
        "Forward monthly cash flow over horizonMonths (6, 12, 24), computed on read and never stored. Baseline: per root Spending Category, the mean (trailing total ÷ 12) of the 12 complete household months of landed spend with no project or on the standing Household project, carried flat; categories with spend in fewer than 3 of the 12 months are Irregular, grouped as one row or separate. Envelopes: remaining = max(0, estimate − subtree net spend, which already includes committed rows and nets credits) for in_progress projects (not_started with includeNotStarted, planning only with an estimate, none under an estimated ancestor), spread evenly to a future end date; otherwise unscheduled. Committed future Expenses land in their month, overdue ones in the current month, never also in an envelope. Scenarios are what-if inflows/outflows; inflows exist only as scenarios.",
      input: cashFlowProjectionInput,
      output: cashFlowProjectionOut,
      // Scenarios are an array of objects; keep them out of a bounded URL.
      cache: { tags: [["expense"], ["project"], ["spendingCategory"]] },
    }),
  },
  { exposure: "capability", mcpToolGroup: "finance" },
);

export const financialTransactionContract = defineContract(
  "financialTransaction",
  {
    allocateSettlement: mutation({
      description:
        "Save explicitly reviewed Purchase settlement allocations only while the exact prior graph remains current. Read all current allocations first and preserve unrelated edges; stale proposals are refused without mutation. Model ranking alone does not authorize an allocation. A charge whose account belongs to another member than the order's vendor account, or is not among the accounts the order's payment evidence or payment-account links name, is refused unless `acknowledgeConflicts.note` explains why; that note becomes the Purchase's confirmed_shared_use or confirmed_tender data exception.",
      command: { label: "Allocate settlement", confirmation: null },
      input: financialSettlementAllocationInput,
      output: financialSettlementAllocationInput.omit({
        priorAllocations: true,
      }),
      invalidates: ["financialTransaction", "purchase", "expense"],
    }),
    acceptTransferPair: mutation({
      description:
        "Pair two existing legs directly; the transfer_pair Suggestions queue (suggestions_read.list family transfer_pair, reviewed through suggestions.review) is the primary review path and also creates missing legs. Pass the positive (outflow) and negative (inflow) FTX- legs. In one transaction it creates a Ledger Transfer from the outflow account's owner to the inflow account's owner for the absolute amount, dated the earlier leg, and links both legs as its evidence. A same-owner pair is recorded as an internal move. Refuses as data (canProceed false with the reason naming the record) unless the signs are opposite, the amounts equal, the accounts differ, both accounts have an owner, and neither leg already evidences a transfer; a refusal writes nothing.",
      command: { label: "Accept transfer pair", confirmation: null },
      input: acceptFinancialTransferPairInput,
      output: acceptFinancialTransferPairOut,
      invalidates: ["financialTransaction", "ledgerTransfer"],
    }),
    converge: mutation({
      description:
        "Automatically book a posted genuine purchase payment only when current server evidence establishes identity, account authority, exact money and unchanged accepted facts. Optionally provide a retained Email for checksum-fenced financial event extraction; transfers, card repayments, refunds, reimbursements and incoming payments are never turned into new purchases. A sole candidate or model ranking grants no write authority. Returns review_required without spending writes when evidence is incomplete or ambiguous.",
      input: financialConvergenceInput,
      output: financialConvergenceResult,
      invalidates: ["financialTransaction", "purchase", "expense", "email"],
    }),
    bookTransaction: mutation({
      description:
        'Book one posted Financial Transaction into spending through the reviewed booking checks (the same preview/commit as the web review, in one call; replays an identical booking). Name `purchaseId` to book into an existing Purchase, or `vendorId` to book into a new lump Purchase dated the transaction day. Incoming credits (income) book only as `economicRole: "reimbursement"`, as a negative reimbursement Expense; a reimbursement naming neither resolves the Vendor its merchant names exactly (name or alias) and refuses an unknown merchant. Links the transaction to the Purchase; never creates a Vendor. Transfers and card repayments are refused.',
      command: { label: "Book transaction", confirmation: null },
      input: financialBookingInput,
      output: financialBookingResult,
      invalidates: ["financialTransaction", "purchase", "expense"],
    }),
    previewBookingCorrection: query({
      description:
        "Preview a correction to existing Financial Transaction booking data. It is read-only and returns the proposed changes and blockers; commit only the reviewed correction.",
      input: financialBookingCorrectionInput,
      output: financialBookingCorrectionPreview,
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
      description:
        "Apply a reviewed Financial Transaction booking correction using the expected state returned by preview_booking_correction. Re-read the affected transactions if the expected state no longer matches.",
      command: { label: "Commit booking correction", confirmation: null },
      input: financialBookingCorrectionPreview,
      output: financialBookingCorrectionResult,
      invalidates: [
        "financialTransaction",
        "purchase",
        "expense",
        "ledgerTransfer",
      ],
    }),
    previewBooking: query({
      description:
        "Preview booking for the selected transaction evidence without writing. Review candidate account, date, and amount assignments before calling commit_booking.",
      input: financialBookingInput,
      output: financialBookingPreview,
      cache: { tags: [["financialTransaction"], ["purchase"], ["expense"]] },
    }),
    commitBooking: mutation({
      description:
        "Book the reviewed transaction evidence using the expected state from preview_booking. It writes Financial Transaction records; re-read them after a stale-state refusal.",
      command: { label: "Commit booking", confirmation: null },
      input: financialBookingPreview,
      output: financialBookingResult,
      invalidates: ["financialTransaction", "purchase", "expense"],
    }),
    previewTransactionImport: query({
      description:
        "Preview client-parsed Monarch statement rows before recording settlement evidence. Normalized rows only — never a CSV path, upload, or file contents; at most 200 rows. Monarch charges are negative in the export and are normalized to positive Cubby outflows; credits become negative. The preview derives a stable source reference from account/date/amount/original statement, resolves an existing Financial Account only when unambiguous, and returns already_recorded, ready_to_create, possible_existing, unresolved_account, or indistinguishable_duplicate per row. Eligible rows may include advisory vendorInference from prior settled transactions with the same Merchant label; it neither matches nor links anything. Unresolved rows include a non-persisted new Account suggestion. It never creates Accounts, Financial Transactions, Purchases, or links: create only user-approved ready_to_create rows afterwards with entity.create(financialTransaction), then review every result.",
      input: financialTransactionImportPreviewInput,
      output: financialTransactionImportPreviewOut,
      cache: { tags: [["financialTransaction"], ["financialAccount"]] },
    }),
    sourceOptions: query({
      exposure: "view",
      input: z.null(),
      output: financialTransactionSourceOptionsOut,
    }),
    vendorInference: query({
      exposure: "view",
      note: "The booking form's vendor prefill for one merchant string; statement import previews carry the inference for real rows",
      input: merchantVendorInferenceInput,
      output: merchantVendorInference,
      cache: { tags: [["financialTransaction"], ["purchase"], ["vendor"]] },
    }),
  },
  { exposure: "capability", mcpToolGroup: "finance" },
);
