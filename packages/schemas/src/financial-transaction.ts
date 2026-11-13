import { withFieldEnvelopes } from "./field-envelope";
import {
  financialTransactionFieldEnvelopeFields,
  financialTransactionPublicReadFields,
} from "./generated/entity-field-envelope-fields.financialTransaction.gen";
import { rawFinancialTransactionOut } from "./financial-transaction-raw-read";
import {
  postedRequiresDate,
  purchaseSettlementKinds,
} from "./financial-transaction-fields";
import { cents, moneyToMinor } from "@cubby/shared";
import { z } from "zod";
import { financialTransactionFilterFields as financialTransactionBaseFilterFields } from "@cubby/schemas/entities/financialTransaction";
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
import { entityFilterList, oneOrMany, presenceFilter } from "./pagination";
import { plainDate } from "./project";
import { externalIdSource } from "./external-id";
import { generatedFinancialTransactionFieldSchemas } from "./generated/entity-field-schemas.financialTransaction.gen";
import {
  type FinancialTransactionKind,
  financialTransactionKind,
  financialTransactionStatus,
  descriptorProcessor,
  financialTransactionProviderStatus,
  financialTransactionAllocation,
  financialTransactionItemization,
  financialTransactionNonZeroAmount as nonZeroAmount,
  financialTransactionSourceRef,
  merchantVendorCandidate,
  merchantVendorInference,
} from "./financial-transaction-fields";
import { uniqueBy } from "./base-entity";

export {
  merchantVendorInference,
  type FinancialTransactionSourceRef,
} from "./financial-transaction-fields";

export {
  financialTransactionKind,
  financialTransactionStatus,
  type FinancialTransactionKind,
} from "./financial-transaction-fields";

/** The same bounded candidate set reaches retrieval and declared ranking. */
export const SETTLEMENT_CANDIDATE_LIMIT = 20;

export { purchaseSettlementKinds };

type PurchaseSettlementKind = (typeof purchaseSettlementKinds)[number];

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
  fee: { sign: "positive", binds: "always" },
  interest: { sign: "positive", binds: "linked" },
  income: { sign: "negative", binds: "linked" },
} as const satisfies Record<
  PurchaseSettlementKind,
  { sign: "positive" | "negative" | "any"; binds: "always" | "linked" }
>;

const purchaseSettlementKindList = purchaseSettlementKinds.join(", ");
const purchaseSettlementKindSet = new Set<FinancialTransactionKind>(
  purchaseSettlementKinds,
);

const isPurchaseSettlementKind = (
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

export const financialTransactionAllocationInput =
  financialTransactionAllocation;

const financialTransactionCreateFields =
  generatedFinancialTransactionFieldSchemas.create;

const settlementStateSchema = z.object({
  purchaseId: z.string().nullable(),
  allocations: z.array(financialTransactionAllocationInput).optional(),
  kind: financialTransactionKind,
  amount: z.number(),
});

/**
 * The refusal when a transaction's allocations do not sum to its amount, compared
 * in whole cents; null when they do. Shared by the input schema and the repository
 * write so both refuse with the same words.
 */
export const allocationSumViolation = (
  allocationAmounts: readonly bigint[],
  transactionAmount: bigint,
): string | null => {
  const total = allocationAmounts.reduce((sum, amount) => sum + amount, 0n);
  const rendered = (value: bigint) => {
    const magnitude = value < 0n ? -value : value;
    return `${value < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}`;
  };
  return total === transactionAmount
    ? null
    : `Allocations must sum to the transaction amount: got ${rendered(total)}, expected ${rendered(transactionAmount)}.`;
};

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
        cents(allocations[0]?.amount ?? 0) === cents(transaction.amount);
      if (!agrees)
        ctx.addIssue({
          code: "custom",
          message:
            "purchaseId and allocations disagree. purchaseId is shorthand for one allocation of the full amount — supply one or the other.",
          path: ["allocations"],
        });
    }

    if (allocations.length > 0) {
      const sumViolation = allocationSumViolation(
        allocations.map((row) => moneyToMinor(row.amount)),
        moneyToMinor(transaction.amount),
      );
      if (sumViolation)
        ctx.addIssue({
          code: "custom",
          message: sumViolation,
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

/** The allocation-integrity gap, the one state its filter selects. */
export const financialTransactionAllocationIntegrity = z.enum(["defect"]);

export const financialTransactionFilterFields = {
  ...financialTransactionBaseFilterFields,
  purchaseId: entityFilterList(purchaseShortcode).optional(),
  purchasePresenceFilter: presenceFilter,
  itemization: oneOrMany(financialTransactionItemization).optional(),
  allocationIntegrity: oneOrMany(
    financialTransactionAllocationIntegrity,
  ).optional(),
  descriptorProcessor: oneOrMany(descriptorProcessor).optional(),
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

export const financialTransactionOut = withFieldEnvelopes(
  rawFinancialTransactionOut,
  financialTransactionFieldEnvelopeFields,
  financialTransactionPublicReadFields,
);

const FINANCIAL_STATEMENT_IMPORT_MAX_ROWS = 200;

/**
 * Provider slugs seen in the wild. Advisory only — `source` is an open slug, not
 * an enum, because the stored `sourceRefs` already carry sixteen free-form slugs
 * and `financialAccountSourceAlias.source` is likewise unconstrained. A closed
 * enum here would be the only closed member of the family and would reject the
 * next export format on the day it is needed.
 */
const KNOWN_STATEMENT_SOURCES = [
  "monarch",
  "copilot",
  "mint",
  "apple-card",
] as const;

/**
 * One already-parsed statement row. Cubby accepts data, never a CSV path or
 * upload: parsing and export handling belong to the MCP client.
 */
const financialTransactionImportRow = z.strictObject({
  importFingerprint: z.string().min(1).optional(),
  rowPosition: z.number().int().positive().optional(),
  providerTransactionId: z.string().min(1).nullable().optional(),
  providerAccountId: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Opaque upstream account ID scoped to the provider; not a Cubby FinancialAccount shortcode.",
    ),
  providerStatus: financialTransactionProviderStatus.optional(),
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
export type FinancialTransactionImportRow = z.infer<
  typeof financialTransactionImportRow
>;

export const financialTransactionImportPreviewInput = z.strictObject({
  rows: z
    .array(financialTransactionImportRow)
    .min(1)
    .max(FINANCIAL_STATEMENT_IMPORT_MAX_ROWS)
    .refine(
      ...uniqueBy(
        (row: FinancialTransactionImportRow) => row.key,
        "rows must have unique keys",
      ),
    ),
});
export type FinancialTransactionImportPreviewInput = z.infer<
  typeof financialTransactionImportPreviewInput
>;

const financialTransactionImportPreviewStatus = z.enum([
  "already_recorded",
  "ready_to_create",
  "possible_existing",
  "unresolved_account",
  "indistinguishable_duplicate",
]);

const financialTransactionImportProposedTransaction = z.object({
  sourceRef: financialTransactionSourceRef,
  amount: nonZeroAmount,
  kind: financialTransactionKind,
  status: financialTransactionStatus.extract(["observed", "pending", "posted"]),
  transactionDate: plainDate.nullable(),
  postedDate: plainDate.nullable(),
  merchant: z.string().nullable(),
  rawDescription: z.string().nullable(),
  sourceCategory: z.string().nullable(),
  notes: z.string().nullable(),
});

const financialStatementNewAccount = z.object({
  name: z.string().min(1),
  identity: financialAccountIdentity,
  cardNumbers: financialAccountCardNumbers,
  sourceAliases: financialAccountSourceAliases,
});

const rawImportPreviewExistingTransaction = z.object({
  id: financialTransactionShortcode,
  /** The provider's own transaction id names this transaction. */
  provider: z.boolean().default(false),
  amount: z.number(),
  status: financialTransactionStatus,
  postedDate: plainDate.nullable(),
  transactionDate: plainDate.nullable(),
  merchant: z.string().nullable(),
  rawDescription: z.string().nullable(),
});
export const importPreviewExistingTransaction = withFieldEnvelopes(
  rawImportPreviewExistingTransaction,
  { merchant: financialTransactionFieldEnvelopeFields.merchant },
  financialTransactionPublicReadFields,
);

const financialTransactionImportPreviewRow = z.object({
  key: z.string(),
  status: financialTransactionImportPreviewStatus,
  accountId: financialAccountShortcode.nullable(),
  accountName: z.string().nullable(),
  newAccount: financialStatementNewAccount.nullable(),
  proposed: financialTransactionImportProposedTransaction,
  existingTransactionIds: z.array(financialTransactionShortcode),
  existingTransactions: z.array(importPreviewExistingTransaction).default([]),
  vendorInference: merchantVendorInference
    .nullable()
    .default(null)
    .describe(
      "Vendor identification from independently confirmed history for the exact normalized statement label. One candidate identifies the Vendor; competing candidates remain ambiguous. Null for completed or duplicate rows; this read does not create an allocation.",
    ),
});

export const financialTransactionImportPreviewOut = z.object({
  rows: z.array(financialTransactionImportPreviewRow),
  summary: z.object({
    rowsIn: z.number().int(),
    alreadyRecorded: z.number().int(),
    readyToCreate: z.number().int(),
    possibleExisting: z.number().int(),
    unresolvedAccount: z.number().int(),
    indistinguishableDuplicate: z.number().int(),
  }),
});

const rawFinancialTransactionImportPreviewRow =
  financialTransactionImportPreviewRow.extend({
    existingTransactions: z
      .array(rawImportPreviewExistingTransaction)
      .default([]),
  });
const rawFinancialTransactionImportPreviewOut =
  financialTransactionImportPreviewOut.extend({
    rows: z.array(rawFinancialTransactionImportPreviewRow),
  });
export type RawFinancialTransactionImportPreviewOut = z.infer<
  typeof rawFinancialTransactionImportPreviewOut
>;
