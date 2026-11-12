import { z } from "zod";
import { expenseEconomicRoleSchema } from "./expense-fields";
import {
  financialTransactionShortcode,
  financialAccountShortcode,
  purchaseShortcode,
  expenseShortcode,
  vendorShortcode,
  spendingCategoryShortcode,
  ledgerTransferShortcode,
  emailShortcode,
  ledgerPartyShortcode,
} from "./identifiers";
import { tradeSchema } from "./task-fields";
import { wholeCentAmount } from "./money";
import { financialTransactionAllocationInput } from "./financial-transaction";
import {
  financialTransactionKind,
  financialTransactionStatus,
  financialTransactionSourceRef,
} from "./financial-transaction-fields";
import { plainDate } from "./project";
import { ledgerAttributions } from "./ledger-party-fields";
import { publicFieldResolutionSchema } from "./field-resolution";

export const FINANCIAL_SPENDING_POLICY = "2026-10-29.2";

/** Advice never bypasses planning; explicit commands and queue policy authorize execution. */
export const financialSpendingAdvice = z.object({
  /** High-confidence classification of an escrow disbursement on a loan. */
  escrowDisbursement: z.boolean().optional(),
  spendingCategoryId: spendingCategoryShortcode.nullable().default(null),
  categoryConfidence: z.enum(["low", "medium", "high"]).default("low"),
  vendorName: z.string().trim().min(1).nullable().default(null),
  vendorConfidence: z.enum(["low", "medium", "high"]).default("low"),
  counterparty: z
    .enum(["business", "person", "payment_processor", "unknown"])
    .default("unknown"),
  historyConflict: z.boolean().default(false),
});
export type FinancialSpendingAdvice = z.infer<typeof financialSpendingAdvice>;

/** The same evidence before and after a statement creates its transaction. */
export const financialSpendingSource = z.object({
  accountId: financialAccountShortcode,
  kind: financialTransactionKind,
  status: financialTransactionStatus,
  amount: wholeCentAmount,
  transactionDate: plainDate.nullable(),
  postedDate: plainDate.nullable(),
  merchant: z.string().nullable(),
  rawDescription: z.string().nullable(),
  sourceRefs: z.array(financialTransactionSourceRef),
});
export const financialSpendingRequest = z.object({
  transactionId: financialTransactionShortcode.optional(),
  source: financialSpendingSource.optional(),
  advice: financialSpendingAdvice.nullable().default(null),
  /** Explicit reviewed choice; null chooses standalone, absence never rejects matches. */
  purchaseId: purchaseShortcode.nullable().optional(),
  vendorId: vendorShortcode.optional(),
  reviewedVendorName: z.string().trim().min(1).optional(),
  spendingCategoryId: spendingCategoryShortcode.optional(),
  /** Reviewed classification for a newly created aggregate; absence keeps source defaults. */
  costType: z.enum(["materials", "tools", "services"]).optional(),
  /** Creation-only reviewed intent; empty resets to defaults, null-party means unknown. */
  beneficiaries: ledgerAttributions.optional(),
  categoryHistoryReviewed: z.boolean().optional(),
  rejectedPurchaseIds: z.array(purchaseShortcode).default([]),
});
const spendingCandidate = z.object({
  purchaseId: purchaseShortcode,
  name: z.string(),
  strength: z.enum(["strong", "weak", "context"]),
});
const spendingPlanBasis = z.object({
  request: financialSpendingRequest,
  snapshot: z.string(),
  candidates: z.array(spendingCandidate),
});
export const financialSpendingPlan = z.discriminatedUnion("status", [
  spendingPlanBasis.extend({
    status: z.literal("deferred"),
    reason: z.string(),
  }),
  spendingPlanBasis.extend({
    status: z.literal("review_required"),
    reason: z.string(),
  }),
  spendingPlanBasis.extend({
    status: z.literal("already_booked"),
    purchaseIds: z.array(purchaseShortcode),
  }),
  spendingPlanBasis.extend({
    status: z.literal("ready"),
    effect: z.enum(["create_aggregate", "link_existing", "settle_existing"]),
    purchaserId: ledgerPartyShortcode.nullable(),
    /** Retained proposals without purchaser proof remain readable but cannot commit or replay. */
    purchaserSnapshot: z.string().optional(),
    vendorId: vendorShortcode.nullable(),
    vendorName: z.string(),
    spendingCategoryId: spendingCategoryShortcode.nullable(),
    categoryOverride: spendingCategoryShortcode.nullable().optional(),
    effectiveCategory: publicFieldResolutionSchema.optional(),
    purchaseId: purchaseShortcode.nullable(),
  }),
]);
export type FinancialSpendingPlan = z.infer<typeof financialSpendingPlan>;

export const financialBookingInput = z.object({
  confirmsMerchant: z
    .boolean()
    .optional()
    .describe(
      "Set false when the Vendor was copied from statement-label inference rather than independently confirmed.",
    ),
  transactionId: financialTransactionShortcode,
  purchaseId: purchaseShortcode.nullable().default(null),
  vendorId: vendorShortcode.nullable().default(null),
  spendingCategoryId: spendingCategoryShortcode.nullable().default(null),
  costType: z.enum(["materials", "tools", "services"]).default("materials"),
  trade: tradeSchema.default("other"),
  economicRole: expenseEconomicRoleSchema.default("vendor"),
  purchaserId: ledgerPartyShortcode.nullable().default(null),
  beneficiaries: ledgerAttributions.optional(),
});
export const financialBookingPreview = financialBookingInput.extend({
  purchaserSnapshot: z.string(),
  spendingCategoryId: spendingCategoryShortcode.nullable().default(null),
  categoryOverride: spendingCategoryShortcode.nullable().default(null),
  /** Optional only so completed predecessor receipts keep their exact parsed bytes. */
  effectiveCategory: publicFieldResolutionSchema.optional(),
  candidateCategoryId: spendingCategoryShortcode.nullable().optional(),
  existingCategories: z
    .array(
      z.object({
        expenseId: expenseShortcode,
        resolution: publicFieldResolutionSchema,
      }),
    )
    .optional(),
  action: z.enum(["create_aggregate", "link_existing"]),
  accountName: z.string(),
  funderName: z.string().nullable().default(null),
  existingBookedAmount: wholeCentAmount,
  previouslySettledAmount: wholeCentAmount,
  remainingBookedAmount: wholeCentAmount,
  snapshot: z.string(),
  amount: wholeCentAmount,
  date: z.string(),
  name: z.string(),
});
export const financialBookingResult = z.object({
  purchaseId: purchaseShortcode,
  expenseId: expenseShortcode.nullable(),
  replayed: z.boolean(),
});
export type FinancialBookingInput = z.infer<typeof financialBookingInput>;
export type FinancialBookingPreview = z.infer<typeof financialBookingPreview>;

/** The reviewed choice wins; otherwise fees and purchases keep their source defaults. */
export function financialSpendingCostType(
  kind: z.infer<typeof financialTransactionKind> | null,
  reviewed?: FinancialBookingInput["costType"],
): FinancialBookingInput["costType"] {
  return reviewed ?? (kind === "fee" ? "services" : "materials");
}

export const financialConvergenceInput = z.strictObject({
  transactionId: financialTransactionShortcode,
  emailId: emailShortcode.optional(),
  advice: financialSpendingAdvice.optional(),
});
export const financialConvergenceResult = z.discriminatedUnion("status", [
  z.object({
    status: z.enum(["applied", "already_recorded"]),
    purchaseId: purchaseShortcode,
    expenseId: expenseShortcode.nullable(),
  }),
  z.object({ status: z.literal("review_required"), reason: z.string() }),
]);
export type FinancialConvergenceInput = z.infer<
  typeof financialConvergenceInput
>;

const financialWorkPreview = z.object({
  transactionId: financialTransactionShortcode,
  canApplyAutomatically: z.boolean(),
  blocker: z.string().nullable(),
  purchaseId: purchaseShortcode.nullable(),
  vendorId: vendorShortcode.nullable(),
  effect: z
    .enum(["link_existing", "create_aggregate", "already_recorded"])
    .nullable(),
});
export type FinancialWorkPreview = z.infer<typeof financialWorkPreview>;

export const financialSettlementAllocationInput = z.strictObject({
  transactionId: financialTransactionShortcode,
  priorAllocations: z
    .array(financialTransactionAllocationInput)
    .describe(
      "Echo the current allocations from the transaction read, including confirmsMerchant. This is the expected state for the stale-write guard.",
    ),
  allocations: z.array(financialTransactionAllocationInput),
  acknowledgeConflicts: z
    .strictObject({ note: z.string().trim().min(1).max(2_000) })
    .optional()
    .describe(
      "Only after reviewing a refusal: allocate despite the charge's account conflicting with the order (another member's account, or one the order's payment evidence does not name). The note is recorded as the data exception on each conflicting Purchase.",
    ),
});
export type FinancialSettlementAllocationInput = z.infer<
  typeof financialSettlementAllocationInput
>;

export const financialBookingCorrectionInput = z.object({
  transactionId: financialTransactionShortcode,
  action: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("attach_reimbursement"),
      purchaseId: purchaseShortcode,
    }),
    z.object({
      kind: z.literal("convert_to_transfer"),
      transferId: ledgerTransferShortcode,
    }),
  ]),
});
export const financialBookingCorrectionPreview =
  financialBookingCorrectionInput.extend({
    snapshot: z.string(),
    amount: wholeCentAmount,
    targetName: z.string(),
    categoryId: spendingCategoryShortcode.nullable().default(null),
    categoryName: z.string().nullable().default(null),
    categoryEmoji: z.string().nullable().default(null),
    projectName: z.string().nullable().default(null),
    trade: tradeSchema.nullable().default(null),
    lines: z.array(
      z.object({
        expenseId: expenseShortcode,
        title: z.string(),
        amount: wholeCentAmount,
        notes: z.string().nullable().default(null),
      }),
    ),
  });
export const financialBookingCorrectionResult = z.object({
  transactionId: financialTransactionShortcode,
  purchaseId: purchaseShortcode.nullable(),
  transferId: ledgerTransferShortcode.nullable(),
  retiredExpenseIds: z.array(expenseShortcode),
});
export type FinancialBookingCorrectionInput = z.infer<
  typeof financialBookingCorrectionInput
>;
export type FinancialBookingCorrectionPreview = z.infer<
  typeof financialBookingCorrectionPreview
>;
