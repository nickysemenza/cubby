import { z } from "zod";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
  purchaseShortcode,
} from "./identifiers";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { plainDate } from "./project";

export const financialTransactionKind = z.enum([
  "purchase",
  "refund",
  "account_transfer",
  "credit_card_payment",
  "fee",
  "interest",
  "income",
  "adjustment",
  "other",
]);
export type FinancialTransactionKind = z.infer<typeof financialTransactionKind>;

export const financialTransactionStatus = z.enum([
  "expected",
  "pending",
  "posted",
  "void",
]);
export type FinancialTransactionStatus = z.infer<
  typeof financialTransactionStatus
>;

export const financialTransactionSourceRef = z.strictObject({
  source: z.string().min(1),
  externalId: z.string().min(1),
});
export type FinancialTransactionSourceRef = z.infer<
  typeof financialTransactionSourceRef
>;

export const financialTransactionSourceRefs = z
  .array(financialTransactionSourceRef)
  .refine((refs) => {
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.source}\u0000${ref.externalId}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  }, "sourceRefs must not contain duplicate source/externalId pairs");

const nonZeroAmount = z
  .number()
  .finite()
  .refine((amount) => amount !== 0, "amount must be non-zero");

const financialTransactionFields = {
  accountId: financialAccountShortcode,
  purchaseId: purchaseShortcode.nullable(),
  kind: financialTransactionKind,
  status: financialTransactionStatus,
  amount: nonZeroAmount,
  transactionDate: plainDate.nullable(),
  postedDate: plainDate.nullable(),
  merchant: z.string().nullable(),
  rawDescription: z.string().nullable(),
  sourceCategory: z.string().nullable(),
  sourceRefs: financialTransactionSourceRefs,
  notes: z.string().nullable(),
};

const financialTransactionCreateShape = {
  ...financialTransactionFields,
  purchaseId: purchaseShortcode.nullable().default(null),
  transactionDate: plainDate.nullable().default(null),
  postedDate: plainDate.nullable().default(null),
  merchant: z.string().nullable().default(null),
  rawDescription: z.string().nullable().default(null),
  sourceCategory: z.string().nullable().default(null),
  sourceRefs: financialTransactionSourceRefs.default([]),
  notes: z.string().nullable().default(null),
};

const postedRequiresDate = <T extends z.ZodType>(schema: T) =>
  schema.refine(
    (value) => {
      const transaction = value as {
        status: FinancialTransactionStatus;
        postedDate: string | null;
      };
      return transaction.status !== "posted" || transaction.postedDate !== null;
    },
    { message: "posted transactions require postedDate", path: ["postedDate"] },
  );

export const financialTransactionCreateInput = postedRequiresDate(
  z.object(financialTransactionCreateShape),
);
export type FinancialTransactionCreateInput = z.infer<
  typeof financialTransactionCreateInput
>;

// A partial update can modify only one half of the posted/status pair. The
// repository validates the resulting persisted state after applying the patch.
export const financialTransactionUpdateData = deriveUpdateData(
  financialTransactionCreateShape,
);
export type FinancialTransactionUpdateData = z.infer<
  typeof financialTransactionUpdateData
>;
export const financialTransactionUpdateInput = z.object({
  id: financialTransactionShortcode,
  data: financialTransactionUpdateData,
});
export type FinancialTransactionUpdateInput = z.infer<
  typeof financialTransactionUpdateInput
>;

export const financialTransactionFilterFields = {
  search: z.string().optional(),
  accountId: oneOrMany(financialAccountShortcode).optional(),
  purchaseId: oneOrMany(purchaseShortcode).optional(),
  purchasePresenceFilter: presenceFilter,
  kind: oneOrMany(financialTransactionKind).optional(),
  status: oneOrMany(financialTransactionStatus).optional(),
  source: oneOrMany(z.string().min(1)).optional(),
  externalId: oneOrMany(z.string().min(1)).optional(),
  merchant: z.string().optional(),
  amountMin: z.coerce.number().finite().optional(),
  amountMax: z.coerce.number().finite().optional(),
  transactionDateFrom: plainDate.optional(),
  transactionDateTo: plainDate.optional(),
  postedDateFrom: plainDate.optional(),
  postedDateTo: plainDate.optional(),
};
export const financialTransactionFiltersSchema = z.object(
  financialTransactionFilterFields,
);
export type FinancialTransactionFilters = z.infer<
  typeof financialTransactionFiltersSchema
>;

export const financialTransactionSortableFields = [
  "transactionDate",
  "postedDate",
  "amount",
  "merchant",
  "kind",
  "status",
  "createdAt",
] as const;
export type FinancialTransactionSortField =
  (typeof financialTransactionSortableFields)[number];

export const financialTransactionOut = postedRequiresDate(
  z.object({
    id: financialTransactionShortcode,
    ...financialTransactionFields,
    accountName: z.string().nullable(),
    ...timestampedFields,
  }),
);
export type FinancialTransactionOut = z.infer<typeof financialTransactionOut>;

export const financialTransactionListResponse = createPaginatedResponseSchema(
  financialTransactionOut,
);
export type FinancialTransactionListResponse = z.infer<
  typeof financialTransactionListResponse
>;

export const financialReconciliationStatus = z.enum([
  "unknown",
  "pending",
  "match",
  "mismatch",
]);
export type FinancialReconciliationStatus = z.infer<
  typeof financialReconciliationStatus
>;

export const financialReconciliationSummary = z.object({
  status: financialReconciliationStatus,
  transactionCount: z.number().int().nonnegative(),
  postedTransactionCount: z.number().int().nonnegative(),
  outstandingTransactionCount: z.number().int().nonnegative(),
  postedTotal: z.number().finite(),
  projectedTotal: z.number().finite(),
  /** Posted refund evidence only; negative under the settlement sign convention. */
  postedRefundTotal: z.number().finite(),
  delta: z.number().finite().nullable(),
});
export type FinancialReconciliationSummary = z.infer<
  typeof financialReconciliationSummary
>;
