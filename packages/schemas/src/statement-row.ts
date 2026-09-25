import { z } from "zod";
import { externalIdSource } from "./external-id";
import { money } from "./money";
import { createSortPaginationFields } from "./pagination";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
} from "./identifiers";
import { dateRangeFields, numericRangeFields, plainDate } from "./base-entity";
import {
  financialStatementImportPreviewOut,
  financialTransactionKind,
  merchantVendorInference,
} from "./financial-transaction";

export const statementCsvColumnMapping = z.strictObject({
  source: z.string(),
  account: z.string(),
  accountColumn: z.string(),
  date: z.string(),
  amount: z.string(),
  description: z.string(),
  merchant: z.string(),
  category: z.string(),
  notes: z.string(),
  direction: z.string(),
  status: z.string(),
  pendingValue: z.string(),
  chargeValue: z.string(),
  creditValue: z.string(),
  sign: z.enum(["charges-negative", "charges-positive", "direction-column"]),
});

export const statementCsvFileInput = z.object({
  fileName: z.string().min(1),
  text: z.string().min(1).max(5_000_000),
  mapping: statementCsvColumnMapping.optional(),
  previewOffset: z.number().int().nonnegative().optional(),
});
export type StatementCsvFileInput = z.infer<typeof statementCsvFileInput>;

export const statementCsvPreviewOut = z.object({
  headers: z.array(z.string()),
  needsMapping: z.boolean(),
  source: z.string().nullable(),
  totalRows: z.number().int(),
  pendingRows: z.number().int(),
  zeroValueRows: z.number().int(),
  previewOffset: z.number().int(),
  hasMore: z.boolean(),
  preview: financialStatementImportPreviewOut.nullable(),
});

export const statementCsvCommitInput = statementCsvFileInput.extend({
  selected: z.array(
    z.object({ key: z.string(), kind: financialTransactionKind }),
  ),
});
export type StatementCsvCommitInput = z.infer<typeof statementCsvCommitInput>;

export const statementCsvCommitOut = z.object({
  transactions: z.number().int(),
  evidence: z.number().int(),
  alreadyPresent: z.number().int(),
});

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

export const statementDateKind = z.enum(["posted", "transaction", "unknown"]);
export type StatementDateKind = z.infer<typeof statementDateKind>;

export const statementRowDisposition = z.enum(["open", "ignored"]);
export type StatementRowDisposition = z.infer<typeof statementRowDisposition>;

/**
 * Why a row will never match. Parallel in style to `dataExceptionReason`, but a
 * deliberately separate set: that vocabulary is about a record Cubby owns being
 * wrong, this one is about a statement line Cubby will never hold.
 */
export const statementRowDispositionReason = z.enum([
  /** Real spend, but of a kind Cubby does not model (consumer purchases). */
  "not_modeled",
  "not_a_purchase",
  "duplicate_of_other_source",
  "pre_cubby",
  "other",
]);
export type StatementRowDispositionReason = z.infer<
  typeof statementRowDispositionReason
>;

export const statementRowProviderStatus = z.enum(["posted", "pending"]);

/**
 * Derived from whether a live transaction carries the row's `(source,
 * externalId)` pair — never stored, so it cannot go stale.
 */
export const statementRowMatchState = z.enum([
  "matched",
  "unmatched",
  "superseded",
  "ignored",
]);
export type StatementRowMatchState = z.infer<typeof statementRowMatchState>;

export const statementImportOut = z.object({
  source: z.string(),
  label: z.string(),
  fingerprint: z.string(),
  dateKind: statementDateKind,
  rowCountDeclared: z.number().int().nullable(),
  rowCountStored: z.number().int(),
  notes: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type StatementImportOut = z.infer<typeof statementImportOut>;

export const statementRowOut = z.object({
  // A statement row's public identity is (source, externalId) — the content
  // hash — not its uuid primary key, which stays inside the repo layer.
  source: z.string(),
  externalId: z.string(),
  importFingerprint: z.string(),

  accountDescriptor: z.string(),
  statementDate: plainDate,
  amount: z.number(),
  providerAmount: z.number(),
  merchant: z.string().nullable(),
  rawDescription: z.string(),
  sourceCategory: z.string().nullable(),
  providerStatus: statementRowProviderStatus.nullable(),
  providerNotes: z.string().nullable(),

  accountId: financialAccountShortcode.nullable(),
  accountName: z.string().nullable(),
  disposition: statementRowDisposition,
  dispositionReason: statementRowDispositionReason.nullable(),
  dispositionNote: z.string().nullable(),
  supersededBy: z.string().nullable(),
  notes: z.string().nullable(),

  matchState: statementRowMatchState,
  transactionId: financialTransactionShortcode.nullable(),
  vendorInference: merchantVendorInference
    .nullable()
    .default(null)
    .describe(
      "Advisory Vendor evidence only. Null for matched, ignored, or superseded rows. It neither matches nor links anything.",
    ),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type StatementRowOut = z.infer<typeof statementRowOut>;

export const statementRowFilters = z.object({
  source: z.string().optional(),
  importFingerprint: z.string().optional(),
  accountId: financialAccountShortcode.optional(),
  matchState: statementRowMatchState.optional(),
  disposition: statementRowDisposition.optional(),
  dispositionReason: statementRowDispositionReason.optional(),
  /**
   * The provider's own category, verbatim. The triage lever that matters: the
   * bulk of any statement import is spend Cubby does not model, and the
   * provider already classified it — so dispositioning "every Restaurants row"
   * is one filtered write rather than thousands of ids.
   */
  sourceCategory: z.string().optional(),
  ...dateRangeFields("date"),
  ...numericRangeFields("amount", { coerce: false }),
  search: z.string().optional(),
});
export type StatementRowFilters = z.infer<typeof statementRowFilters>;

export const statementRowSortableFields = [
  "statementDate",
  "amount",
  "accountDescriptor",
  "rawDescription",
  "createdAt",
] as const;

export const STATEMENT_ROW_RECORD_MAX_ROWS = 500;

export const statementImportInput = z.strictObject({
  source: externalIdSource,
  label: z.string().min(1),
  fingerprint: z.string().min(1),
  dateKind: statementDateKind.default("unknown"),
  rowCountDeclared: z.number().int().nonnegative().nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type StatementImportInput = z.infer<typeof statementImportInput>;

/**
 * A provider row as the client parsed it. `externalId` is absent by design —
 * the server derives it, so a client cannot mint an identity that disagrees
 * with the one `sourceRefs` matching depends on.
 */
export const statementRowInput = z.strictObject({
  accountDescriptor: z.string().min(1),
  statementDate: plainDate,
  /**
   * The charge as the export stated it, normalized to CHARGES-NEGATIVE.
   *
   * Providers disagree — Monarch signs charges negative, Copilot signs them
   * positive, Mint leaves them unsigned with the sign in a separate column, and
   * Apple Card signs them positive — so the client must normalize before
   * submitting. This is load-bearing rather than cosmetic: the row's identity
   * hash is computed over this value, so submitting an un-normalized export
   * does not merely flip a sign, it mints a SECOND identity for a charge
   * already recorded and the row can never match.
   */
  providerAmount: z.number().refine((value) => value !== 0, {
    message: "providerAmount must be non-zero",
  }),
  merchant: z.string().nullable().default(null),
  rawDescription: z.string().min(1),
  sourceCategory: z.string().nullable().default(null),
  providerStatus: statementRowProviderStatus.nullable().default(null),
  providerNotes: z.string().nullable().default(null),
});
export type StatementRowInput = z.infer<typeof statementRowInput>;

export const recordStatementRowsInput = z.strictObject({
  import: statementImportInput,
  rows: z.array(statementRowInput).min(1).max(STATEMENT_ROW_RECORD_MAX_ROWS),
  /**
   * Derive every identity and report what a real call would do, then write
   * nothing — no batch, no rows.
   *
   * The server owns the hash, so before this the only way to learn whether a
   * chunk was already recorded was to reproduce `statementRowExternalId`
   * offline and query for the results. Ask the server instead.
   */
  dryRun: z.boolean().default(false),
});
export type RecordStatementRowsInput = z.infer<typeof recordStatementRowsInput>;

export const recordStatementRowsOut = z.object({
  batchId: z.string().nullable(),
  batchCreated: z.boolean(),
  /** Echoes the request, so a caller cannot mistake a preview for a write. */
  dryRun: z.boolean(),
  inserted: z.number().int(),
  unchanged: z.number().int(),
  alreadyInThisBatch: z.number().int(),
  alreadyInAnotherBatch: z.number().int(),
  /**
   * Present more than once inside this payload. Two provider rows that hash
   * identically are indistinguishable, so only the first can ever be stored —
   * `financial-statement-preview` calls the same state
   * `indistinguishable_duplicate`. A real same-amount-same-day pair (two $4.50
   * coffees) lands here and needs a distinguishing `rawDescription`.
   */
  indistinguishableDuplicates: z.number().int(),
  rowsOmitted: z.number().int().nullable(),
  rowCountStored: z.number().int(),
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
type StatementRowFilterValue = StatementRowFilters[keyof StatementRowFilters];
const hasStatementRowFilterValue = (value: StatementRowFilterValue): boolean =>
  value !== undefined && value !== "";

export const statementRowSelector = z.union([
  z.strictObject({
    source: externalIdSource,
    externalIds: z.array(z.string()).min(1).max(500),
  }),
  z.strictObject({
    filter: statementRowFilters.refine(
      (value) => Object.values(value).some(hasStatementRowFilterValue),
      "filter must restrict something; an empty filter would address every row",
    ),
  }),
]);
export type StatementRowSelector = z.infer<typeof statementRowSelector>;

/**
 * Only the judgment fields. Provider evidence is immutable after ingest, which
 * is enforced by this schema's shape rather than by convention.
 */
export const statementRowUpdateData = z.strictObject({
  accountId: financialAccountShortcode.nullable().optional(),
  disposition: statementRowDisposition.optional(),
  dispositionReason: statementRowDispositionReason.nullable().optional(),
  dispositionNote: z.string().nullable().optional(),
  supersededByExternalId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type StatementRowUpdateData = z.infer<typeof statementRowUpdateData>;

export const updateStatementRowsInput = z.strictObject({
  selector: statementRowSelector,
  data: statementRowUpdateData,
});
export type UpdateStatementRowsInput = z.infer<typeof updateStatementRowsInput>;

/**
 * Two live rows that are the same charge under two identities.
 *
 * The hash covers `rawDescription`, so a charge re-exported after its
 * descriptor firms up (`AMAZON MKTPLACE PMTS` → `AMAZON MKTPL*XD8AR9RG3`)
 * mints a SECOND identity for money already recorded. The hash cannot be
 * fixed — it is stored externally in `FinancialTransaction.sourceRefs` with
 * no back-reference — so drift is detected rather than prevented.
 *
 * Reported, never acted on: the remedy links one row to the other with
 * `supersededByExternalId`, and which row superseded which is a judgment.
 * Same-amount-same-day coincidences are real (two $4.50 coffees), so a
 * candidate is a question, not a finding.
 */
export const statementRowDriftCandidate = z.object({
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
      providerStatus: statementRowProviderStatus.nullable(),
      disposition: statementRowDisposition,
      importFingerprint: z.string(),
      createdAt: z.date(),
    }),
  ),
});
export type StatementRowDriftCandidate = z.infer<
  typeof statementRowDriftCandidate
>;

export const findStatementRowDriftInput = z.object({
  source: z.string().optional(),
  ...dateRangeFields("date"),
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
export type FindStatementRowDriftInput = z.infer<
  typeof findStatementRowDriftInput
>;

export const findStatementRowDriftOut = z.object({
  candidates: z.array(statementRowDriftCandidate),
  /**
   * True when `limit` cut the list. A bounded sweep that says nothing about
   * what it dropped reads as "no more drift", which is the opposite of true.
   */
  truncated: z.boolean(),
});

export const deleteStatementRowsInput = z.strictObject({
  selector: statementRowSelector,
});

export const statementRowWriteOut = z.object({
  affected: z.number().int(),
});

/** Shared by the browser workflow and MCP tool, so they cannot drift. */
export const listStatementRowsInput = z.object({
  filters: statementRowFilters.optional(),
  ...createSortPaginationFields({
    sortableFields: statementRowSortableFields,
    defaultSort: "statementDate",
  }),
});

export const statementRowSummaryInput = z.object({
  filters: statementRowFilters.optional(),
});

export const listStatementImportsInput = z.object({
  source: externalIdSource.optional(),
});

export const statementRowListOut = z.object({
  data: z.array(statementRowOut),
  count: z.number().int(),
});

export const statementRowSummaryOut = z.object({
  total: z.number().int(),
  matched: z.number().int(),
  unmatched: z.number().int(),
  ignored: z.number().int(),
  superseded: z.number().int(),
  amountTotal: money,
  unmatchedAmount: money,
});

export const statementImportListOut = z.object({
  data: z.array(statementImportOut),
  count: z.number().int(),
});
