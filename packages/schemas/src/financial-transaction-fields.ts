import { z } from "zod";
import { uniqueBy } from "./base-entity";
import { purchaseShortcode, vendorShortcode } from "./identifiers";
import { wholeCentAmount } from "./money";
import { plainDate } from "./base-entity";

export const financialTransactionNonZeroAmount = wholeCentAmount.refine(
  (amount) => amount !== 0,
  "amount must be non-zero",
);

export const financialTransactionSourceRef = z.strictObject({
  source: z.string().min(1),
  externalId: z.string().min(1),
});
export type FinancialTransactionSourceRef = z.infer<
  typeof financialTransactionSourceRef
>;
export const financialTransactionSourceRefs = z
  .array(financialTransactionSourceRef)
  .refine(
    ...uniqueBy<FinancialTransactionSourceRef>(
      (ref) => `${ref.source}\u0000${ref.externalId}`,
      "sourceRefs must not contain duplicate source/externalId pairs",
    ),
  );

export const financialTransactionAllocation = z.object({
  purchaseId: purchaseShortcode,
  amount: wholeCentAmount,
});
export const financialTransactionAllocations = z.array(
  financialTransactionAllocation,
);

export const merchantVendorCandidate = z.object({
  vendorId: vendorShortcode,
  vendorName: z.string().min(1),
  supportingTransactionCount: z.number().int().positive(),
  lastSeenDate: plainDate.nullable(),
});
const noMerchantVendorCandidates = z.object({
  status: z.literal("none"),
  candidates: z.tuple([]),
});
const insufficientMerchantVendorCandidate = merchantVendorCandidate.extend({
  supportingTransactionCount: z.literal(1),
});
const suggestedMerchantVendorCandidate = merchantVendorCandidate.extend({
  supportingTransactionCount: z.number().int().min(2),
});
export const merchantVendorInference = z.discriminatedUnion("status", [
  noMerchantVendorCandidates,
  z.object({
    status: z.literal("insufficient_history"),
    candidates: z.tuple([insufficientMerchantVendorCandidate]),
  }),
  z.object({
    status: z.literal("suggested"),
    candidates: z.tuple([suggestedMerchantVendorCandidate]),
  }),
  z.object({
    status: z.literal("ambiguous"),
    candidates: z.array(merchantVendorCandidate).min(2),
  }),
]);
