import { z } from "zod";

import {
  generatedFinancialTransactionKindValues,
  generatedFinancialTransactionStatusValues,
} from "./generated/entity-field-schemas.financialTransaction.gen";
import { financialTransactionSourceRef } from "./financial-transaction-fields";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
} from "./identifiers";
import { plainDate } from "./project";

const kind = z.enum(generatedFinancialTransactionKindValues);
const status = z.enum(generatedFinancialTransactionStatusValues);

export const statementTransactionAction = z.enum([
  "create",
  "attach",
  "supersede",
  "void",
]);
export type StatementTransactionAction = z.infer<
  typeof statementTransactionAction
>;

/** How the proposed kind was chosen; only `rule` is bulk-acceptable. */
export const statementTransactionKindSource = z.enum(["rule", "model", "sign"]);

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
});

export type StatementTransactionCandidate = z.infer<
  typeof statementTransactionCandidate
>;

export const statementTransactionCreate = z.object({
  kind,
  kindSource: statementTransactionKindSource,
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

export const STATEMENT_SUGGESTION_PAGE_MAX = 500;

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

export const listStatementSuggestionGroupsInput = z.object({});

export const listStatementSuggestionsInput = z.object({
  filters: statementSuggestionFilters.default({}),
  limit: z.number().int().min(1).max(STATEMENT_SUGGESTION_PAGE_MAX).default(50),
  offset: z.number().int().min(0).default(0),
});

const publicCandidate = statementTransactionCandidate
  .omit({ transactionId: true })
  .extend({ transactionId: financialTransactionShortcode });

export const statementSuggestionOut = z.object({
  assessmentId: z.string(),
  fingerprint: z.string().nullable(),
  source: z.string(),
  chargeKey: z.string(),
  accountId: financialAccountShortcode,
  accountName: z.string(),
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
  siblings: z.number().int(),
  model: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type StatementSuggestionOut = z.infer<typeof statementSuggestionOut>;

export const statementSuggestionListOut = z.object({
  data: z.array(statementSuggestionOut),
  count: z.number().int(),
});

export const statementSuggestionGroupOut = z.object({
  accountId: financialAccountShortcode,
  accountName: z.string(),
  month: z.string(),
  total: z.number().int(),
  clean: z.number().int(),
  create: z.number().int(),
  attach: z.number().int(),
  supersede: z.number().int(),
  void: z.number().int(),
  amount: z.number(),
});
export const statementSuggestionGroupsOut = z.array(
  statementSuggestionGroupOut,
);

const chargeCursor = z.object({
  source: z.string().min(1),
  chargeKey: z.string().min(1),
});

export const refreshStatementSuggestionsInput = z.object({
  /** Resume after this charge; omit to start a full pass. */
  after: chargeCursor.nullable().default(null),
});

export const refreshStatementSuggestionsOut = z.object({
  published: z.number().int(),
  unchanged: z.number().int(),
  /** Set when no queue continues the pass: call again with it to page on. */
  next: chargeCursor.nullable(),
  /** The remaining pages continue in the background. */
  queued: z.boolean(),
});
