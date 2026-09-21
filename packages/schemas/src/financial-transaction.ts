import { z } from "zod";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
export {
  financialReconciliationStatus,
  financialReconciliationSummary,
} from "./financial-reconciliation";
export type {
  FinancialReconciliationStatus,
  FinancialReconciliationSummary,
} from "./financial-reconciliation";
import { financialTransactionRelatedFilterFields } from "./related-view";
import { auditDateFilterFields } from "./base-entity";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
  purchaseShortcode,
} from "./identifiers";
import {
  financialAccountCardNumbers,
  financialAccountIdentity,
  financialAccountSourceAliases,
} from "./financial-account";
import {
  createPaginatedResponseSchema,
  entityFilterList,
  oneOrMany,
  presenceFilter,
} from "./pagination";
import { plainDate } from "./project";
import { externalIdSource } from "./external-id";
import {
  generatedFinancialTransactionFieldSchemas,
  generatedFinancialTransactionFilterFields,
  generatedFinancialTransactionKindValues,
  generatedFinancialTransactionStatusValues,
} from "./generated/entity-field-schemas.financialTransaction.gen";
import {
  financialTransactionAllocation,
  financialTransactionNonZeroAmount as nonZeroAmount,
  financialTransactionSourceRef,
  merchantVendorCandidate,
  merchantVendorInference,
} from "./financial-transaction-fields";
import { uniqueBy } from "./base-entity";

export {
  financialTransactionSourceRef,
  financialTransactionSourceRefs,
  merchantVendorCandidate,
  merchantVendorInference,
  type FinancialTransactionSourceRef,
} from "./financial-transaction-fields";

export const financialTransactionKind = z.enum(
  generatedFinancialTransactionKindValues,
);
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
  income: { sign: "negative", binds: "linked" },
} as const satisfies Record<
  PurchaseSettlementKind,
  { sign: "positive" | "negative" | "any"; binds: "always" | "linked" }
>;

const purchaseSettlementKindList = purchaseSettlementKinds.join(", ");
const purchaseSettlementKindSet = new Set<FinancialTransactionKind>(
  purchaseSettlementKinds,
);

export const isPurchaseSettlementKind = (
  kind: FinancialTransactionKind,
): kind is PurchaseSettlementKind => purchaseSettlementKindSet.has(kind);

export const financialTransactionSettlementViolation = (value: {
  /**
   * Whether this transaction settles any Purchase at all.
   *
   * Explicit rather than derived from a `purchaseId`, because that column is a
   * transitional mirror that is NULL for a transaction split across several
   * Purchases — such a row is very much linked, and inferring otherwise would
   * silently switch this rule off on exactly the rows it most needs to bind to.
   */
  linked: boolean;
  kind: FinancialTransactionKind;
  amount: number;
}): { path: "kind" | "amount"; message: string } | null => {
  const linked = value.linked;
  if (linked && !isPurchaseSettlementKind(value.kind)) {
    return {
      path: "kind",
      message: `only ${purchaseSettlementKindList} transactions may link to a Purchase`,
    };
  }
  if (!isPurchaseSettlementKind(value.kind)) return null;

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
 * "This row's amount has the right sign for its kind" as SQL, generated from
 * `purchaseSettlementSignRules`. Scoped to rows already known to be LINKED, so
 * `binds` is not consulted — every rule applies to a linked row.
 *
 * Exported because two things need it and neither may hand-write it: the DB
 * CHECK below, and `findFinancialTransactionAllocationDefects`, which is what
 * still enforces this rule for a transaction split across several Purchases —
 * such a row's mirror `purchaseId` is NULL, so the CHECK passes vacuously and
 * the detector is the only thing left watching.
 */
export const purchaseSettlementSignSatisfiedExpression = (columns: {
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
  return `(${clauses.join(" OR ")})`;
};

export const purchaseSettlementKindAllowedExpression = (kindColumn: string) =>
  `${kindColumn} IN (${quoteKinds(purchaseSettlementKinds)})`;

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
}): string =>
  `${columns.purchaseId} IS NULL OR (${purchaseSettlementKindAllowedExpression(
    columns.kind,
  )} AND ${purchaseSettlementSignSatisfiedExpression(columns)})`;

export const financialTransactionStatus = z.enum(
  generatedFinancialTransactionStatusValues,
);
export type FinancialTransactionStatus = z.infer<
  typeof financialTransactionStatus
>;

export const financialTransactionAllocationOut = financialTransactionAllocation;
export const financialTransactionAllocationInput =
  financialTransactionAllocation;
export type FinancialTransactionAllocationInput = z.infer<
  typeof financialTransactionAllocationInput
>;

const financialTransactionCreateFields =
  generatedFinancialTransactionFieldSchemas.create;

const postedDateStatusSchema = z.object({
  status: financialTransactionStatus,
  postedDate: plainDate.nullable(),
});

const settlementStateSchema = z.object({
  purchaseId: z.string().nullable(),
  allocations: z.array(financialTransactionAllocationInput).optional(),
  kind: financialTransactionKind,
  amount: z.number(),
});

const postedRequiresDate = <T extends z.ZodType>(schema: T) =>
  schema.refine(
    (value) => {
      const transaction = postedDateStatusSchema.parse(value);
      return transaction.status !== "posted" || transaction.postedDate !== null;
    },
    { message: "posted transactions require postedDate", path: ["postedDate"] },
  );

const validSettlementState = <T extends z.ZodType>(schema: T) =>
  schema.superRefine((value, ctx) => {
    const transaction = settlementStateSchema.parse(value);
    const allocations = transaction.allocations ?? [];

    // `purchaseId` is sugar for one allocation of the full amount. Supplying
    // both is only coherent when they agree; picking a winner silently would
    // make the input's meaning depend on which field the writer trusted.
    if (transaction.purchaseId !== null && allocations.length > 0) {
      const agrees =
        allocations.length === 1 &&
        allocations[0]?.purchaseId === transaction.purchaseId &&
        Math.round((allocations[0]?.amount ?? 0) * 100) ===
          Math.round(transaction.amount * 100);
      if (!agrees)
        ctx.addIssue({
          code: "custom",
          message:
            "purchaseId and allocations disagree. purchaseId is shorthand for one allocation of the full amount — supply one or the other.",
          path: ["allocations"],
        });
    }

    if (allocations.length > 0) {
      const total = allocations.reduce(
        (sum, row) => sum + Math.round(row.amount * 100),
        0,
      );
      if (total !== Math.round(transaction.amount * 100))
        ctx.addIssue({
          code: "custom",
          message: `allocations must sum to the transaction amount: got ${(total / 100).toFixed(2)}, expected ${transaction.amount.toFixed(2)}`,
          path: ["allocations"],
        });
      if (
        allocations.some(
          (row) => Math.sign(row.amount) !== Math.sign(transaction.amount),
        )
      )
        ctx.addIssue({
          code: "custom",
          message:
            "every allocation must carry the same sign as its transaction; a charge and a credit are two settlement events",
          path: ["allocations"],
        });
    }

    const violation = financialTransactionSettlementViolation({
      linked: transaction.purchaseId !== null || allocations.length > 0,
      kind: transaction.kind,
      amount: transaction.amount,
    });
    if (violation) {
      ctx.addIssue({
        code: "custom",
        message: violation.message,
        path: [violation.path],
      });
    }
  });

export const financialTransactionCreateInput = validSettlementState(
  postedRequiresDate(z.object(financialTransactionCreateFields).strict()),
);
export type FinancialTransactionCreateInput = z.infer<
  typeof financialTransactionCreateInput
>;

// A partial update can modify only one half of the posted/status pair. The
// repository validates the resulting persisted state after applying the patch.
export const financialTransactionUpdateData = z
  .object(generatedFinancialTransactionFieldSchemas.update)
  .strict();
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
  ...generatedFinancialTransactionFilterFields,
  accountId: entityFilterList(financialAccountShortcode).optional(),
  purchaseId: entityFilterList(purchaseShortcode).optional(),
  purchasePresenceFilter: presenceFilter,
  allocationIntegrity: z.enum(["defect"]).optional(),
  source: oneOrMany(z.string().min(1)).optional(),
  externalId: oneOrMany(z.string().min(1)).optional(),
};
export const financialTransactionFiltersSchema = z.object(
  financialTransactionFilterFields,
);

export const financialTransactionSourceOptionsOut = z.array(
  z.object({ source: z.string(), count: z.number().int() }),
);
export type FinancialTransactionSourceOptionsOut = z.infer<
  typeof financialTransactionSourceOptionsOut
>;
export type FinancialTransactionFilters = z.infer<
  typeof financialTransactionFiltersSchema
>;

export type MerchantVendorCandidate = z.infer<typeof merchantVendorCandidate>;
export type MerchantVendorInference = z.infer<typeof merchantVendorInference>;

export const merchantVendorInferenceInput = z.object({
  merchant: z.string(),
});
export type MerchantVendorInferenceInput = z.infer<
  typeof merchantVendorInferenceInput
>;

export type FinancialTransactionSortField =
  GeneratedEntitySortField<"financialTransaction">;

export const financialTransactionOut = postedRequiresDate(
  z.object(generatedFinancialTransactionFieldSchemas.read),
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
 * Provider slugs seen in the wild. Advisory only — `source` is an open slug, not
 * an enum, because the stored `sourceRefs` already carry sixteen free-form slugs
 * and `financialAccountSourceAlias.source` is likewise unconstrained. A closed
 * enum here would be the only closed member of the family and would reject the
 * next export format on the day it is needed.
 */
export const KNOWN_STATEMENT_SOURCES = [
  "monarch",
  "copilot",
  "mint",
  "apple-card",
] as const;

/**
 * One already-parsed statement row. Cubby accepts data, never a CSV path or
 * upload: parsing and export handling belong to the MCP client.
 */
export const financialStatementImportRow = z.strictObject({
  key: z.string().min(1),
  source: externalIdSource
    .default("monarch")
    .describe(
      `Provider slug, conventionally one of ${KNOWN_STATEMENT_SOURCES.join(", ")}. Any slug is accepted; a new one simply namespaces its own refs.`,
    ),
  account: z.string().min(1),
  date: plainDate,
  amount: nonZeroAmount,
  merchant: z.string().nullable().default(null),
  originalStatement: z.string().min(1),
  category: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
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
  cardNumbers: financialAccountCardNumbers,
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
  vendorInference: merchantVendorInference
    .nullable()
    .default(null)
    .describe(
      "Advisory Vendor evidence only. Null for completed or duplicate rows. It neither matches nor links anything.",
    ),
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
