import { z } from "zod";
import { financialTransactionRelatedFilterFields } from "./related-view";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
  purchaseShortcode,
} from "./identifiers";
import {
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "./financial-account";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { plainDate } from "./project";
import { wholeCentAmount } from "./money";

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

export const purchaseSettlementKinds = [
  "purchase",
  "refund",
  "adjustment",
] as const satisfies readonly FinancialTransactionKind[];

export const isPurchaseSettlementKind = (
  kind: FinancialTransactionKind,
): kind is (typeof purchaseSettlementKinds)[number] =>
  purchaseSettlementKinds.includes(
    kind as (typeof purchaseSettlementKinds)[number],
  );

export const financialTransactionSettlementViolation = (value: {
  purchaseId: unknown | null;
  kind: FinancialTransactionKind;
  amount: number;
}): { path: "kind" | "amount"; message: string } | null => {
  if (value.purchaseId !== null && !isPurchaseSettlementKind(value.kind)) {
    return {
      path: "kind",
      message:
        "only purchase, refund, or adjustment transactions may link to a Purchase",
    };
  }
  if (value.kind === "purchase" && value.amount <= 0) {
    return { path: "amount", message: "purchase amounts must be positive" };
  }
  if (value.kind === "refund" && value.amount >= 0) {
    return { path: "amount", message: "refund amounts must be negative" };
  }
  return null;
};

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

const nonZeroAmount = wholeCentAmount.refine(
  (amount) => amount !== 0,
  "amount must be non-zero",
);

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

const validSettlementState = <T extends z.ZodType>(schema: T) =>
  schema.superRefine((value, ctx) => {
    const transaction = value as {
      purchaseId: unknown | null;
      kind: FinancialTransactionKind;
      amount: number;
    };
    const violation = financialTransactionSettlementViolation(transaction);
    if (violation) {
      ctx.addIssue({
        code: "custom",
        message: violation.message,
        path: [violation.path],
      });
    }
  });

export const financialTransactionCreateInput = validSettlementState(
  postedRequiresDate(z.object(financialTransactionCreateShape)),
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
  ...financialTransactionRelatedFilterFields,
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

// ---------------------------------------------------------------------------
// MCP-client statement-import preview
// ---------------------------------------------------------------------------

/** Largest client-parsed statement batch one preview accepts. */
export const FINANCIAL_STATEMENT_IMPORT_MAX_ROWS = 200;

/**
 * One already-parsed Monarch row. Cubby accepts data, never a CSV path or
 * upload: parsing and export handling belong to the MCP client.
 */
export const financialStatementImportRow = z.strictObject({
  key: z.string().min(1),
  source: z.literal("monarch").default("monarch"),
  account: z.string().min(1),
  date: plainDate,
  /** Monarch signs charges negative and credits positive. */
  amount: nonZeroAmount,
  merchant: z.string().nullable().default(null),
  originalStatement: z.string().min(1),
  category: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  /** The client may classify non-purchase statement activity explicitly. */
  kind: financialTransactionKind.optional(),
});
export type FinancialStatementImportRow = z.infer<
  typeof financialStatementImportRow
>;

export const financialStatementImportPreviewInput = z.strictObject({
  rows: z
    .array(financialStatementImportRow)
    .min(1)
    .max(FINANCIAL_STATEMENT_IMPORT_MAX_ROWS)
    .refine(
      (rows) => new Set(rows.map((row) => row.key)).size === rows.length,
      "rows must have unique keys",
    ),
});
export type FinancialStatementImportPreviewInput = z.infer<
  typeof financialStatementImportPreviewInput
>;

export const financialStatementImportPreviewStatus = z.enum([
  "already_recorded",
  "ready_to_create",
  "possible_existing",
  "unresolved_account",
  "indistinguishable_duplicate",
]);
export type FinancialStatementImportPreviewStatus = z.infer<
  typeof financialStatementImportPreviewStatus
>;

const financialStatementImportProposedTransaction = z.object({
  sourceRef: financialTransactionSourceRef,
  amount: nonZeroAmount,
  kind: financialTransactionKind,
  status: z.literal("posted"),
  transactionDate: plainDate.nullable(),
  postedDate: plainDate,
  merchant: z.string().nullable(),
  rawDescription: z.string().nullable(),
  sourceCategory: z.string().nullable(),
  notes: z.string().nullable(),
});

/** A non-persisted account suggestion for an unresolved statement descriptor. */
const financialStatementProvisionalAccount = z.object({
  name: z.string().min(1),
  identity: financialAccountIdentity,
  provisional: z.literal(true),
  sourceAliases: financialAccountSourceAliases,
});

export const financialStatementImportPreviewRow = z.object({
  key: z.string(),
  status: financialStatementImportPreviewStatus,
  accountId: financialAccountShortcode.nullable(),
  accountName: z.string().nullable(),
  provisionalAccount: financialStatementProvisionalAccount.nullable(),
  proposed: financialStatementImportProposedTransaction,
  existingTransactionIds: z.array(financialTransactionShortcode),
});

export const financialStatementImportPreviewOut = z.object({
  rows: z.array(financialStatementImportPreviewRow),
  summary: z.object({
    rowsIn: z.number().int(),
    alreadyRecorded: z.number().int(),
    readyToCreate: z.number().int(),
    possibleExisting: z.number().int(),
    unresolvedAccount: z.number().int(),
    indistinguishableDuplicate: z.number().int(),
  }),
});
export type FinancialStatementImportPreviewOut = z.infer<
  typeof financialStatementImportPreviewOut
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
