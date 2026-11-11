import { z } from "zod";

import {
  financialTransactionKind as kind,
  financialTransactionStatus as status,
  financialTransactionSourceRef,
  financialTransactionProviderStatus,
} from "./financial-transaction-fields";
import {
  financialAccountShortcode,
  ledgerPartyShortcode,
  financialTransactionShortcode,
} from "./identifiers";
import { plainDate } from "./project";
import { statementTransferPairRef } from "./transfer-pair-suggestion";
import {
  financialSpendingPlan,
  financialSpendingRequest,
} from "./financial-booking";

/** Bump with prompt, model-policy or advice eligibility changes; retained votes carry this revision. */
export const STATEMENT_LABEL_REVISION = "2026-10-24.1";

export const statementTransactionAction = z.enum([
  "create",
  "attach",
  "supersede",
  "void",
  "book",
]);
export type StatementTransactionAction = z.infer<
  typeof statementTransactionAction
>;

/**
 * Which source chose the proposed kind; agreement, not the source, decides `clean`.
 * @public Names a generated native model.
 */
export const statementTransactionKindSource = z.enum(["rule", "model", "sign"]);

/**
 * Each source's vote on a create's kind. A kind is bulk-acceptable only when
 * at least two votes name it and none names another; `null` abstains and
 * `mixed` (merchant history of several kinds) disagrees with every kind.
 * Defaults carry judgments published before the votes were recorded.
 * @public Names a generated native model.
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
const statementOwnAccountMove = z.object({
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

/**
 * Advisory model reading of one candidate; it never authorizes an action.
 * @public Names a generated native model.
 */
export const statementCandidateLabel = z.object({
  same: z.enum(["same", "different", "insufficient"]),
  confidence: z.enum(["low", "medium", "high"]),
  model: z.string().nullable(),
});

/** Judgments hold internal ids; public reads map them to shortcodes. */
const statementTransactionCandidate = z.object({
  transactionId: z.uuid(),
  amount: z.number(),
  status,
  postedDate: plainDate.nullable(),
  transactionDate: plainDate.nullable(),
  merchant: z.string().nullable(),
  rawDescription: z.string().nullable(),
  diff: z.array(statementTransactionField),
  label: statementCandidateLabel.nullable(),
  /**
   * `context` candidates (settled by another charge, wrong sign or amount)
   * stay listed but never block a create or earn an attach recommendation;
   * `explicit` ones are named by evidence (provider match, hold, paired copy).
   */
  eligibility: z.enum(["explicit", "eligible", "context"]).default("eligible"),
  contextReason: z
    .enum(["settled", "claimed", "sign", "amount", "kind", "void"])
    .nullable()
    .default(null),
});

export type StatementTransactionCandidate = z.infer<
  typeof statementTransactionCandidate
>;

const statementTransactionCreate = z.object({
  kind,
  kindSource: statementTransactionKindSource,
  votes: statementKindVotes.default({ rule: null, label: null, history: null }),
  counterparty: statementCounterparty.default({
    label: null,
    history: null,
    storedValue: false,
  }),
  status: status.extract(["observed", "pending", "posted"]),
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
  reviewReason: z.string().nullable().default(null),
  accountId: z.uuid(),
  statementDate: plainDate,
  providerStatus: financialTransactionProviderStatus.nullable(),
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
  /** Older stored judgments use same-source charge keys. */
  siblings: z.array(
    z.union([
      z.string(),
      z.object({ source: z.string(), chargeKey: z.string() }),
    ]),
  ),
  /** Charges sharing this bank event's account, amount and window in any source; refreshed once this charge books. */
  copies: z
    .array(z.object({ source: z.string(), chargeKey: z.string() }))
    .default([]),
  /** The Transaction another source's copy of this bank event is booked to. */
  pairedTransactionId: z.uuid().nullable().default(null),
  transfer: statementOwnAccountMove.nullable().default(null),
  transferPair: statementTransferPairRef.nullable().default(null),
  matchedTransactionId: z.uuid().optional(),
  spending: financialSpendingPlan.nullable().optional(),
  clean: z.boolean(),
});
export type StatementTransactionJudgment = z.infer<
  typeof statementTransactionJudgment
>;

/** Unpublished model work owned by one pending suggestion, fenced by its inputs. */
export const statementLabelCheckpoint = z.object({
  revision: z.string(),
  /** One producer only when all retained decision answers used that model. */
  model: z.string().nullable(),
  models: z.array(z.string()),
  judgment: statementTransactionJudgment,
  kind: z.boolean(),
  counterparty: z.boolean(),
  spending: z.boolean().default(false),
});
export type StatementLabelCheckpoint = z.infer<typeof statementLabelCheckpoint>;

/** Publication retains its input position until ordered automatic application settles. */
export const statementApplicationOrder = z.object({
  createdAt: z.string(),
  id: z.uuid(),
});

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
  booking: financialSpendingRequest
    .omit({ transactionId: true, source: true, advice: true })
    .optional(),
});
export type StatementTransactionApplication = z.infer<
  typeof statementTransactionApplication
>;

export const statementSuggestionPreviewInput = z.strictObject({
  suggestionId: z
    .uuid()
    .describe(
      "Opaque Suggestion review handle from suggestions_read.list; not a household entity shortcode.",
    ),
  expectedFingerprint: z.string().min(1),
  application: statementTransactionApplication,
});
export const statementSuggestionPreviewOut = z.object({
  suggestionId: statementSuggestionPreviewInput.shape.suggestionId,
  fingerprint: z.string(),
  action: statementTransactionAction,
  kind: kind.nullable(),
  amount: z.number(),
  status,
  transactionDate: plainDate.nullable(),
  postedDate: plainDate.nullable(),
  merchant: z.string().nullable(),
  rawDescription: z.string().nullable(),
  spending: financialSpendingPlan.nullable(),
});
export type StatementSuggestionPreviewOut = z.infer<
  typeof statementSuggestionPreviewOut
>;

const publicCandidate = statementTransactionCandidate
  .omit({ transactionId: true })
  .extend({ transactionId: financialTransactionShortcode });

export const statementSuggestionOut = z.object({
  suggestionId: z.string(),
  fingerprint: z.string().nullable(),
  source: z.string(),
  chargeKey: z.string(),
  accountId: financialAccountShortcode,
  ownerId: ledgerPartyShortcode.nullable(),
  statementDate: plainDate,
  amount: z.number(),
  merchant: z.string().nullable(),
  rawDescription: z.string(),
  sourceCategory: z.string().nullable(),
  /** Distinct provider/category observations from the charge's retained evidence. */
  sourceCategories: z
    .array(
      z.object({
        source: z.string(),
        sourceCategory: z.string().nullable(),
      }),
    )
    .default([]),
  providerStatus: financialTransactionProviderStatus.nullable(),
  recommended: statementTransactionAction,
  reviewReason: z.string().nullable().default(null),
  clean: z.boolean(),
  create: statementTransactionCreate.omit({ sourceRef: true }).nullable(),
  matchedTransactionId: financialTransactionShortcode.optional(),
  spending: financialSpendingPlan.nullable().optional(),
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
