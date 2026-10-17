import { z } from "zod";
import {
  financialTransactionShortcode,
  purchaseShortcode,
  expenseShortcode,
  vendorShortcode,
  spendingCategoryShortcode,
  ledgerTransferShortcode,
  emailShortcode,
} from "./identifiers";
import { tradeSchema } from "./task-fields";
import { wholeCentAmount } from "./money";
import { financialTransactionAllocationInput } from "./financial-transaction";

export const financialBookingInput = z.object({
  transactionId: financialTransactionShortcode,
  purchaseId: purchaseShortcode.nullable().default(null),
  vendorId: vendorShortcode.nullable().default(null),
  spendingCategoryId: spendingCategoryShortcode.nullable().default(null),
  costType: z.enum(["materials", "tools", "services"]).default("materials"),
  trade: tradeSchema.default("other"),
  economicRole: z.enum(["vendor", "reimbursement"]).default("vendor"),
});
export const financialBookingPreview = financialBookingInput.extend({
  spendingCategoryId: spendingCategoryShortcode.nullable().default(null),
  categoryOverride: spendingCategoryShortcode.nullable().default(null),
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

export const financialConvergenceInput = z.strictObject({
  transactionId: financialTransactionShortcode,
  emailId: emailShortcode.optional(),
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

export const financialWorkPreview = z.object({
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
  priorAllocations: z.array(financialTransactionAllocationInput),
  allocations: z.array(financialTransactionAllocationInput),
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
    categoryName: z.string().nullable().default(null),
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
