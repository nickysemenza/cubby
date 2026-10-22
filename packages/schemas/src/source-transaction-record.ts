import { z } from "zod";
import { externalIdSource } from "./external-id";
import { money } from "./money";
import { createSortPaginationFields } from "./pagination";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
  transactionImportShortcode,
} from "./identifiers";
import { numericRangeFields, plainDate } from "./base-entity";

/**
 * The provider-statement ledger: what the card statements said, stored verbatim
 * so "which statement rows have no Cubby counterpart?" is a query rather than a
 * pipeline rebuilt from scratch each session.
 *
 * These are evidence, not decisions. Nothing here resolves an account, links a
 * Purchase, creates a transaction, or declares two rows the same charge — an
 * agent makes every one of those judgments, and only the judgment fields are
 * writable after ingest.
 */

export * from "./source-transaction-record-fields";
import {
  statementDateKind,
  sourceTransactionRecordDisposition,
  sourceTransactionRecordDispositionReason,
  sourceTransactionRecordProviderStatus,
  sourceTransactionRecordMatchState,
} from "./source-transaction-record-fields";

import { sourceTransactionRecordBaseFilterFields } from "./generated/sourceTransactionRecord.gen";
import { sourceTransactionRecordOut } from "./generated/sourceTransactionRecord.gen";
export {
  sourceTransactionRecordOut,
  type SourceTransactionRecordOut,
} from "./generated/sourceTransactionRecord.gen";
export {
  transactionImportOut,
  type TransactionImportOut,
} from "./transaction-import";
import { transactionImportOut } from "./transaction-import";

export const sourceTransactionRecordFilterFields = {
  ...sourceTransactionRecordBaseFilterFields,
};
export const sourceTransactionRecordFilters = z.object(
  sourceTransactionRecordFilterFields,
);
export type SourceTransactionRecordFilters = z.infer<
  typeof sourceTransactionRecordFilters
>;

export const sourceTransactionRecordLegacyFilters = z.object({
  source: z.string().optional(),
  importFingerprint: z.string().optional(),
  accountId: financialAccountShortcode.optional(),
  matchState: sourceTransactionRecordMatchState.optional(),
  disposition: sourceTransactionRecordDisposition.optional(),
  dispositionReason: sourceTransactionRecordDispositionReason.optional(),
  /**
   * The provider's own category, verbatim. The provider already classified
   * every row, so a bulk pass over "every Restaurants row" is one filtered
   * write rather than thousands of ids.
   */
  sourceCategory: z.string().optional(),
  // Plain days, not relative tokens: these filters also select the rows a
  // source_transaction_records mutation writes, and mutations resolve no filter tokens.
  dateFrom: plainDate.optional(),
  dateTo: plainDate.optional(),
  ...numericRangeFields("amount", { coerce: false }),
  search: z.string().optional(),
});
export type SourceTransactionRecordLegacyFilters = z.infer<
  typeof sourceTransactionRecordLegacyFilters
>;

export const sourceTransactionRecordSortableFields = [
  "statementDate",
  "amount",
  "accountDescriptor",
  "rawDescription",
  "createdAt",
] as const;

export const STATEMENT_ROW_RECORD_MAX_ROWS = 500;

export const transactionImportInput = z.strictObject({
  source: externalIdSource,
  label: z.string().min(1),
  fingerprint: z.string().min(1),
  dateKind: statementDateKind.default("unknown"),
  rowCountDeclared: z.number().int().nonnegative().nullable().default(null),
  observedAt: z.iso.datetime().optional(),
  coverage: z
    .strictObject({
      account: z.string().min(1),
      from: plainDate,
      to: plainDate,
      visibility: z.enum(["all", "visible"]),
    })
    .refine((value) => value.from <= value.to, "Coverage dates are reversed")
    .optional(),
  notes: z.string().nullable().default(null),
});
export type TransactionImportInput = z.infer<typeof transactionImportInput>;

/**
 * A provider row as the client parsed it. `externalId` is absent by design —
 * the server derives it, so a client cannot mint an identity that disagrees
 * with the one `sourceRefs` matching depends on.
 */
export const sourceTransactionRecordInput = z.strictObject({
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
  providerData: z.json().nullable().optional(),
  accountDescriptor: z.string().min(1),
  statementDate: plainDate,
  /**
   * The provider amount, normalized to CHARGES-NEGATIVE. Zero-value occurrences
   * are retained as evidence and never become FinancialTransactions.
   *
   * Providers disagree — Monarch signs charges negative, Copilot signs them
   * positive, Mint leaves them unsigned with the sign in a separate column, and
   * Apple Card signs them positive — so the client must normalize before
   * submitting. This is load-bearing rather than cosmetic: the legacy identity
   * hash is computed over this value, so submitting an un-normalized export
   * does not merely flip a sign, it mints a SECOND identity for a charge
   * already recorded and the row can never match.
   */
  providerAmount: z.number().finite(),
  merchant: z.string().nullable().default(null),
  rawDescription: z.string(),
  sourceCategory: z.string().nullable().default(null),
  providerStatus: sourceTransactionRecordProviderStatus
    .nullable()
    .default(null),
  providerNotes: z.string().nullable().default(null),
});
export type SourceTransactionRecordInput = z.infer<
  typeof sourceTransactionRecordInput
>;

export const recordSourceTransactionRecordsInput = z.strictObject({
  import: transactionImportInput,
  rows: z
    .array(sourceTransactionRecordInput)
    .max(STATEMENT_ROW_RECORD_MAX_ROWS)
    .refine((rows) => {
      const positions = rows.flatMap((row) =>
        row.rowPosition === undefined ? [] : [row.rowPosition],
      );
      return new Set(positions).size === positions.length;
    }, "Physical row positions must be unique within a batch"),
  /**
   * Derive every identity and report what a real call would do, then write
   * nothing — no batch, no rows.
   *
   * The server owns the hash, so before this the only way to learn whether a
   * chunk was already recorded was to reproduce `sourceTransactionRecordExternalId`
   * offline and query for the results. Ask the server instead.
   */
  dryRun: z.boolean().default(false),
  complete: z.boolean().default(false),
  confirmedWithdrawals: z
    .array(z.string().min(1))
    .max(STATEMENT_ROW_RECORD_MAX_ROWS)
    .default([]),
});
export type RecordSourceTransactionRecordsInput = z.infer<
  typeof recordSourceTransactionRecordsInput
>;

export const recordSourceTransactionRecordsOut = z.object({
  batchId: transactionImportShortcode.nullable(),
  batchCreated: z.boolean(),
  /** Echoes the request, so a caller cannot mistake a preview for a write. */
  dryRun: z.boolean(),
  inserted: z.number().int(),
  unchanged: z.number().int(),
  alreadyInThisBatch: z.number().int(),
  alreadyInAnotherBatch: z.number().int(),
  rowCountStored: z.number().int(),
  completed: z.boolean(),
  revised: z.number().int(),
  refreshed: z.number().int(),
  withdrawn: z.number().int(),
  correctionReviews: z.array(
    z.object({
      transactionId: financialTransactionShortcode,
      reason: z.string(),
    }),
  ),
  /**
   * Set when the batch looks un-normalized — the signature of a Copilot or
   * Apple Card export submitted verbatim.
   *
   * Advisory, never fatal: a payroll or refund batch is legitimately
   * all-positive, so rejecting on sign would block correct imports. The rows
   * are already written by the time this is read, which is the point — it tells
   * you to check before submitting the next 30 chunks, when the damage is 500
   * mis-identified rows rather than 15,000.
   */
  signWarning: z.string().nullable().default(null),
});

/**
 * Which rows a bulk write addresses.
 *
 * Two shapes because triage has two scales. Naming ids is right for a handful
 * of judged rows; a filter is the only workable shape for the bulk of the
 * backlog, where roughly 9,000 of 15,386 rows are consumer spend that will
 * never match and dispositioning them one id at a time is not practical.
 *
 * `filter` deliberately reuses the list filters, so what you select is exactly
 * what you were just looking at. An empty filter is refused rather than treated
 * as "everything" — the one case where "unrestricted" is the wrong default,
 * since here it would silently rewrite the whole ledger's judgments.
 */
type SourceTransactionRecordFilterValue =
  SourceTransactionRecordLegacyFilters[keyof SourceTransactionRecordLegacyFilters];
const hasSourceTransactionRecordFilterValue = (
  value: SourceTransactionRecordFilterValue,
): boolean => value !== undefined && value !== "";

export const sourceTransactionRecordSelector = z.union([
  z.strictObject({
    source: externalIdSource,
    externalIds: z.array(z.string()).min(1).max(500),
  }),
  z.strictObject({
    filter: sourceTransactionRecordLegacyFilters.refine(
      (value) =>
        Object.values(value).some(hasSourceTransactionRecordFilterValue),
      "filter must restrict something; an empty filter would address every row",
    ),
  }),
]);
export type SourceTransactionRecordSelector = z.infer<
  typeof sourceTransactionRecordSelector
>;

/**
 * Only the judgment fields. Provider evidence is immutable after ingest, which
 * is enforced by this schema's shape rather than by convention.
 */
export {
  sourceTransactionRecordUpdateData,
  type SourceTransactionRecordUpdateData,
} from "./generated/sourceTransactionRecord.gen";

export const sourceTransactionRecordLegacyUpdateData = z.strictObject({
  accountId: financialAccountShortcode.nullable().optional(),
  disposition: sourceTransactionRecordDisposition.optional(),
  dispositionReason: sourceTransactionRecordDispositionReason
    .nullable()
    .optional(),
  dispositionNote: z.string().nullable().optional(),
  supersededByExternalId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type SourceTransactionRecordLegacyUpdateData = z.infer<
  typeof sourceTransactionRecordLegacyUpdateData
>;

export const updateSourceTransactionRecordsInput = z.strictObject({
  selector: sourceTransactionRecordSelector,
  data: sourceTransactionRecordLegacyUpdateData,
});
export type UpdateSourceTransactionRecordsInput = z.infer<
  typeof updateSourceTransactionRecordsInput
>;

/**
 * Two live rows that are the same charge under two identities.
 *
 * The hash covers `rawDescription`, so a charge re-exported after its
 * descriptor firms up (`AMAZON MKTPLACE PMTS` → `AMAZON MKTPL*XD8AR9RG3`)
 * mints a SECOND identity for money already recorded. The hash cannot be
 * fixed — it is stored externally as a `settlement_ref` `EntityExternalId` on the
 * transaction (its `sourceRefs`) with no back-reference — so drift is detected rather than prevented.
 *
 * Reported, never acted on: the remedy links one row to the other with
 * `supersededByExternalId`, and which row superseded which is a judgment.
 * Same-amount-same-day coincidences are real (two $4.50 coffees), so a
 * candidate is a question, not a finding.
 */
export const sourceTransactionRecordDriftCandidate = z.object({
  source: z.string(),
  accountDescriptor: z.string(),
  statementDate: plainDate,
  providerAmount: z.number(),
  /**
   * The rows came from different exports — the signature of descriptor drift,
   * since one export speaks one descriptor vocabulary. On the full 33,681-row
   * ledger this separates the two findings exactly: all 9 known drift pairs are
   * cross-batch, and all 240 same-batch groups are genuine same-day same-amount
   * coincidences (two payroll deposits, a repeated coffee).
   */
  crossBatch: z.boolean(),
  rows: z.array(
    z.object({
      externalId: z.string(),
      rawDescription: z.string(),
      merchant: z.string().nullable(),
      providerStatus: sourceTransactionRecordProviderStatus.nullable(),
      disposition: sourceTransactionRecordDisposition,
      importFingerprint: z.string(),
      createdAt: z.date(),
    }),
  ),
});
export type SourceTransactionRecordDriftCandidate = z.infer<
  typeof sourceTransactionRecordDriftCandidate
>;

export const findSourceTransactionRecordDriftInput = z.object({
  source: z.string().optional(),
  dateFrom: plainDate.optional(),
  dateTo: plainDate.optional(),
  importFingerprint: z.string().optional(),
  /**
   * Also report groups whose rows all came from ONE export.
   *
   * Off by default: a single export speaks one descriptor vocabulary, so two of
   * its rows differing only in description are two real charges, not one charge
   * seen twice. On the production ledger that is 240 groups of noise against 0
   * real findings — enough to bury the drift the sweep exists to surface.
   */
  includeSameBatch: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
});
export type FindSourceTransactionRecordDriftInput = z.infer<
  typeof findSourceTransactionRecordDriftInput
>;

export const findSourceTransactionRecordDriftOut = z.object({
  candidates: z.array(sourceTransactionRecordDriftCandidate),
  /**
   * True when `limit` cut the list. A bounded sweep that says nothing about
   * what it dropped reads as "no more drift", which is the opposite of true.
   */
  truncated: z.boolean(),
});

export const deleteSourceTransactionRecordsInput = z.strictObject({
  selector: sourceTransactionRecordSelector,
});

export const sourceTransactionRecordWriteOut = z.object({
  affected: z.number().int(),
});

/** Shared by the browser workflow and MCP tool, so they cannot drift. */
export const listSourceTransactionRecordsInput = z.object({
  filters: sourceTransactionRecordLegacyFilters.optional(),
  ...createSortPaginationFields({
    sortableFields: sourceTransactionRecordSortableFields,
    defaultSort: "statementDate",
  }),
});

export const sourceTransactionRecordSummaryInput = z.object({
  filters: sourceTransactionRecordLegacyFilters.optional(),
});

export const listTransactionImportsInput = z.object({
  source: externalIdSource.optional(),
});

export const sourceTransactionRecordListOut = z.object({
  data: z.array(sourceTransactionRecordOut),
  count: z.number().int(),
});

export const sourceTransactionRecordSummaryOut = z.object({
  total: z.number().int(),
  matched: z.number().int(),
  unmatched: z.number().int(),
  ignored: z.number().int(),
  superseded: z.number().int(),
  amountTotal: money,
  /** `amountTotal` split by match state; the four sum to it. */
  matchedAmount: money,
  unmatchedAmount: money,
  ignoredAmount: money,
  supersededAmount: money,
  /** Distinct provider charges behind the unmatched observations. */
  unmatchedCharges: z.number().int(),
});

export const transactionImportListOut = z.object({
  data: z.array(transactionImportOut),
  count: z.number().int(),
});
