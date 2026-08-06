import { z } from "zod";
export {
  financialReconciliationStatus,
  financialReconciliationSummary,
} from "./financial-reconciliation";
export type {
  FinancialReconciliationStatus,
  FinancialReconciliationSummary,
} from "./financial-reconciliation";
import { financialTransactionRelatedFilterFields } from "./related-view";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
  uniqueBy,
} from "./base-entity";
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

/**
 * Kinds that may carry a `purchaseId`, i.e. that can act as settlement evidence
 * for a Purchase.
 *
 * `income` is here for sale proceeds. A disposal is modelled as a Purchase whose
 * Expenses are negative, and the marketplace payout that settles it is an
 * inflow — not a `refund` (which means "the vendor gave money back for goods I
 * returned", and is separately needed on sale Purchases for real refunds to
 * buyers) and not a `purchase` (which is validated positive).
 *
 * The DB CHECK `FinancialTransaction_purchase_settlement_check` in
 * apps/web/src/server/db/schema.ts is generated from this constant and the sign
 * table below, via `purchaseSettlementCheckExpression` — nothing about the rule
 * is written twice.
 */
export const purchaseSettlementKinds = [
  "purchase",
  "refund",
  "adjustment",
  "income",
] as const satisfies readonly FinancialTransactionKind[];

export type PurchaseSettlementKind = (typeof purchaseSettlementKinds)[number];

/**
 * Sign rule per settlement kind, and whether it binds only while the row is
 * linked to a Purchase.
 *
 * `satisfies Record<PurchaseSettlementKind, ...>` is the point: adding a kind to
 * `purchaseSettlementKinds` without giving it a sign rule is a **compile error**.
 * Membership and signs therefore cannot drift apart, and the SQL CHECK below is
 * generated from this same table rather than hand-mirrored.
 */
const purchaseSettlementSignRules = {
  purchase: { sign: "positive", binds: "always" },
  refund: { sign: "negative", binds: "always" },
  adjustment: { sign: "any", binds: "always" },
  // Sale proceeds. Unlinked income (salary, interest) carries no settlement
  // semantics; income attached to a Purchase is a payout, and payouts are inflows.
  income: { sign: "negative", binds: "linked" },
} as const satisfies Record<
  PurchaseSettlementKind,
  { sign: "positive" | "negative" | "any"; binds: "always" | "linked" }
>;

const purchaseSettlementKindList = purchaseSettlementKinds.join(", ");

export const isPurchaseSettlementKind = (
  kind: FinancialTransactionKind,
): kind is PurchaseSettlementKind =>
  purchaseSettlementKinds.includes(kind as PurchaseSettlementKind);

export const financialTransactionSettlementViolation = (value: {
  purchaseId: unknown | null;
  kind: FinancialTransactionKind;
  amount: number;
}): { path: "kind" | "amount"; message: string } | null => {
  const linked = value.purchaseId !== null;
  if (linked && !isPurchaseSettlementKind(value.kind)) {
    return {
      path: "kind",
      message: `only ${purchaseSettlementKindList} transactions may link to a Purchase`,
    };
  }
  if (!isPurchaseSettlementKind(value.kind)) return null;

  // Finite-key Record, so this stays defined under noUncheckedIndexedAccess.
  const rule = purchaseSettlementSignRules[value.kind];
  if (rule.binds === "linked" && !linked) return null;
  if (rule.sign === "positive" && value.amount <= 0) {
    return {
      path: "amount",
      message: `${value.kind} amounts must be positive`,
    };
  }
  if (rule.sign === "negative" && value.amount >= 0) {
    return {
      path: "amount",
      message:
        rule.binds === "linked"
          ? `${value.kind} linked to a Purchase must be negative`
          : `${value.kind} amounts must be negative`,
    };
  }
  return null;
};

const quoteKinds = (kinds: readonly string[]) =>
  kinds.map((kind) => `'${kind}'`).join(", ");

/**
 * The SQL body of `FinancialTransaction_purchase_settlement_check`, generated
 * from `purchaseSettlementSignRules` so the DB constraint cannot drift from the
 * TypeScript rule above. The CHECK is scoped to linked rows, so `binds` is not
 * consulted here — every rule applies.
 */
export const purchaseSettlementCheckExpression = (columns: {
  purchaseId: string;
  kind: string;
  amount: string;
}): string => {
  const withSign = (sign: "positive" | "negative" | "any") =>
    purchaseSettlementKinds.filter(
      (kind) => purchaseSettlementSignRules[kind].sign === sign,
    );
  const clauses = [
    ...(withSign("positive").length
      ? [
          `(${columns.kind} IN (${quoteKinds(withSign("positive"))}) AND ${columns.amount} > 0)`,
        ]
      : []),
    ...(withSign("negative").length
      ? [
          `(${columns.kind} IN (${quoteKinds(withSign("negative"))}) AND ${columns.amount} < 0)`,
        ]
      : []),
    ...(withSign("any").length
      ? [`${columns.kind} IN (${quoteKinds(withSign("any"))})`]
      : []),
  ];
  return `${columns.purchaseId} IS NULL OR (${columns.kind} IN (${quoteKinds(
    purchaseSettlementKinds,
  )}) AND (${clauses.join(" OR ")}))`;
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
  .refine(
    ...uniqueBy(
      (ref: FinancialTransactionSourceRef) =>
        `${ref.source}\u0000${ref.externalId}`,
      "sourceRefs must not contain duplicate source/externalId pairs",
    ),
  );

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
  ...auditDateFilterFields,
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

/**
 * The distinct `sourceRefs[].source` values in use — feeds the transactions
 * table's Source filter. A static option list would rot: sources are minted by
 * whatever importer wrote the row (`monarch`, `zoro`, `amazon-order-export`,
 * `cb2-order-detail`), so the roster has to come from the data.
 */
export const financialTransactionSourceOptionsOut = z.array(
  z.object({ source: z.string(), count: z.number().int() }),
);
export type FinancialTransactionSourceOptionsOut = z.infer<
  typeof financialTransactionSourceOptionsOut
>;
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
  "updatedAt",
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
      ...uniqueBy(
        (row: FinancialStatementImportRow) => row.key,
        "rows must have unique keys",
      ),
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
