import { z } from "zod";

import {
  generatedFinancialTransactionKindValues,
  generatedFinancialTransactionStatusValues,
} from "./generated/entity-field-schemas.financialTransaction.gen";
import { financialTransactionSourceRef } from "./financial-transaction-fields";
import {
  financialAccountShortcode,
  ledgerPartyShortcode,
  financialTransactionShortcode,
} from "./identifiers";
import { plainDate } from "./project";
import { statementTransferPairRef } from "./transfer-pair-suggestion";

const kind = z.enum(generatedFinancialTransactionKindValues);
const status = z.enum(generatedFinancialTransactionStatusValues);

/** Bump with any statement label prompt/model-policy change; retained votes carry this revision. */
export const STATEMENT_LABEL_REVISION = "2026-10-17.1";

export const statementTransactionAction = z.enum([
  "create",
  "attach",
  "supersede",
  "void",
]);
export type StatementTransactionAction = z.infer<
  typeof statementTransactionAction
>;

/** Which source chose the proposed kind; agreement, not the source, decides `clean`. */
export const statementTransactionKindSource = z.enum(["rule", "model", "sign"]);

/**
 * Each source's vote on a create's kind. A kind is bulk-acceptable only when
 * at least two votes name it and none names another; `null` abstains and
 * `mixed` (merchant history of several kinds) disagrees with every kind.
 * Defaults carry judgments published before the votes were recorded.
 */
export const statementKindVotes = z.object({
  /** The provider-category rule, or an own-account move the descriptor names. */
  rule: kind.nullable(),
  /** A high-confidence decision-model label. */
  label: kind.nullable(),
  /** Earlier member-made transactions on the account with the same merchant. */
  history: z.union([kind, z.literal("mixed")]).nullable(),
});
export type StatementKindVotes = z.infer<typeof statementKindVotes>;

const counterpartyKind = z.enum(["person", "business"]);
/** Who is on the other side; a person counterparty is never bulk-acceptable. */
export const statementCounterparty = z.object({
  /** A high-confidence decision-model label. */
  label: counterpartyKind.nullable(),
  history: counterpartyKind.nullable(),
  /**
   * The charge's account holds stored value (a payment app). Its payees are
   * mostly people whose notes read like merchants, so only history, never the
   * label alone, establishes a business there.
   */
  storedValue: z.boolean().default(false),
});
export type StatementCounterparty = z.infer<typeof statementCounterparty>;

/** The member's own balance account a cash-out or funding descriptor names. */
export const statementOwnAccountMove = z.object({
  /** Null when several of the member's accounts fit the descriptor. */
  accountId: z.uuid().nullable(),
  /** The accounts have different owners: a LedgerTransfer is also owed. */
  ledgerTransfer: z.boolean(),
});

// Transaction column names rather than a vocabulary of their own, so they are
// declared outside an inline enum: SQL that names these columns is not using
// a schema enum value.
const transactionFields = ["amount", "postedDate", "status"] as const;

/** Fields an attach or supersede may copy from the statement onto the transaction. */
export const statementTransactionField = z.enum(transactionFields);

/** Advisory model reading of one candidate; it never authorizes an action. */
export const statementCandidateLabel = z.object({
  same: z.enum(["same", "different", "insufficient"]),
  confidence: z.enum(["low", "medium", "high"]),
  model: z.string().nullable(),
});

/** Judgments hold internal ids; public reads map them to shortcodes. */
export const statementTransactionCandidate = z.object({
  transactionId: z.uuid(),
  amount: z.number(),
  status,
  postedDate: plainDate.nullable(),
  transactionDate: plainDate.nullable(),
  merchant: z.string().nullable(),
  rawDescription: z.string().nullable(),
  diff: z.array(statementTransactionField),
  label: statementCandidateLabel.nullable(),
  /** The transaction already settles another charge from this source. */
  claimed: z.boolean().default(false),
});

export type StatementTransactionCandidate = z.infer<
  typeof statementTransactionCandidate
>;

export const statementTransactionCreate = z.object({
  kind,
  kindSource: statementTransactionKindSource,
  votes: statementKindVotes.default({ rule: null, label: null, history: null }),
  counterparty: statementCounterparty.default({
    label: null,
    history: null,
    storedValue: false,
  }),
  status: z.enum(["posted", "pending"]),
  amount: z.number(),
  transactionDate: plainDate.nullable(),
  postedDate: plainDate.nullable(),
  merchant: z.string().nullable(),
  rawDescription: z.string().nullable(),
  sourceCategory: z.string().nullable(),
  notes: z.string().nullable(),
  sourceRef: financialTransactionSourceRef,
});

export const statementTransactionJudgment = z.object({
  recommended: statementTransactionAction,
  accountId: z.uuid(),
  statementDate: plainDate,
  providerStatus: z.enum(["posted", "pending"]),
  create: statementTransactionCreate.nullable(),
  candidates: z.array(statementTransactionCandidate),
  supersede: z
    .object({
      pendingTransactionId: z.uuid(),
      pendingRowIds: z.array(z.uuid()).min(1),
      postedRowId: z.uuid(),
    })
    .nullable(),
  void: z
    .object({ transactionId: z.uuid(), coverageImportId: z.uuid() })
    .nullable(),
  /** Other unmatched charges that could be the same money under a firmed-up descriptor. */
  siblings: z.array(z.string()),
  transfer: statementOwnAccountMove.nullable().default(null),
  transferPair: statementTransferPairRef.nullable().default(null),
  clean: z.boolean(),
});
export type StatementTransactionJudgment = z.infer<
  typeof statementTransactionJudgment
>;

/**
 * The member's chosen action. A choice that differs from the recommendation is
 * reviewed as Wrong with this application as its correction.
 */
export const statementTransactionApplication = z.object({
  kind: z.literal("statement_transaction"),
  action: statementTransactionAction,
  transactionId: financialTransactionShortcode.optional(),
  fields: z.array(statementTransactionField).default([]),
  kindOverride: kind.optional(),
  rejectedCandidateIds: z.array(financialTransactionShortcode).default([]),
});
export type StatementTransactionApplication = z.infer<
  typeof statementTransactionApplication
>;

export const statementSuggestionFilters = z.object({
  accountId: financialAccountShortcode.optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  action: statementTransactionAction.optional(),
  clean: z.boolean().optional(),
});
export type StatementSuggestionFilters = z.infer<
  typeof statementSuggestionFilters
>;

const publicCandidate = statementTransactionCandidate
  .omit({ transactionId: true })
  .extend({ transactionId: financialTransactionShortcode });

export const statementSuggestionOut = z.object({
  assessmentId: z.string(),
  fingerprint: z.string().nullable(),
  source: z.string(),
  chargeKey: z.string(),
  accountId: financialAccountShortcode,
  /** The account's owner. */
  ownerId: ledgerPartyShortcode.nullable(),
  statementDate: plainDate,
  amount: z.number(),
  merchant: z.string().nullable(),
  rawDescription: z.string(),
  sourceCategory: z.string().nullable(),
  providerStatus: z.enum(["posted", "pending"]),
  recommended: statementTransactionAction,
  clean: z.boolean(),
  create: statementTransactionCreate.omit({ sourceRef: true }).nullable(),
  candidates: z.array(publicCandidate),
  supersedeTransactionId: financialTransactionShortcode.nullable(),
  voidTransactionId: financialTransactionShortcode.nullable(),
  /** A descriptor's account hint; the transfer pair supplies opposite-leg evidence. */
  transfer: statementOwnAccountMove
    .extend({ accountId: financialAccountShortcode.nullable() })
    .nullable()
    .default(null),
  transferPair: statementTransferPairRef.nullable().default(null),
  siblings: z.number().int(),
  model: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type StatementSuggestionOut = z.infer<typeof statementSuggestionOut>;
