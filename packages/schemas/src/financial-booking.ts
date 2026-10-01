import { z } from "zod";
import {
  financialTransactionShortcode,
  purchaseShortcode,
  expenseShortcode,
  vendorShortcode,
  spendingCategoryShortcode,
  ledgerTransferShortcode,
} from "./identifiers";
import { tradeSchema } from "./task-fields";
import { wholeCentAmount } from "./money";

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
  spendingCategoryId: spendingCategoryShortcode,
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
