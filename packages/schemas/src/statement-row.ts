import { z } from "zod";
import { externalIdSource } from "./external-id";
import { createSortPaginationFields } from "./pagination";
import {
  financialAccountShortcode,
  financialTransactionShortcode,
} from "./identifiers";
import { plainDate } from "./base-entity";

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

/** Which date convention an export's rows carry. Recorded, never resolved. */
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
  /** Not a purchase at all: transfer, payment, interest, fee. */
  "not_a_purchase",
  /** The same charge is already recorded from another provider's export. */
  "duplicate_of_other_source",
  /** Predates the ledger; no Purchase was ever kept for it. */
  "pre_cubby",
  "other",
]);
export type StatementRowDispositionReason = z.infer<
  typeof statementRowDispositionReason
>;

/** Provider-reported settlement state, kept because a pending row's hash moves. */
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
  /** Rows actually stored. Short of `rowCountDeclared` means a partial ingest. */
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
  /** The export this row came from, by its client-supplied fingerprint. */
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
  /** The transaction carrying this row's ref, when one does. */
  transactionId: financialTransactionShortcode.nullable(),
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
  dateFrom: plainDate.optional(),
  dateTo: plainDate.optional(),
  amountMin: z.number().optional(),
  amountMax: z.number().optional(),
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

/**
 * Rows per `record_statement_rows` call. Higher than the preview's 200 because
 * this is one multi-row INSERT with no per-row query; the full 15k-row backlog
 * is ~31 calls.
 */
export const STATEMENT_ROW_RECORD_MAX_ROWS = 500;

/** One export's identity. Found-or-created by `(source, fingerprint)`. */
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
  /** The export's own signed figure; Monarch signs charges negative. */
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
});
export type RecordStatementRowsInput = z.infer<typeof recordStatementRowsInput>;

export const recordStatementRowsOut = z.object({
  batchId: z.string(),
  batchCreated: z.boolean(),
  inserted: z.number().int(),
  /** Already present under the same `(source, externalId)` — re-ingest is a no-op. */
  unchanged: z.number().int(),
  rowCountStored: z.number().int(),
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
export const statementRowSelector = z.union([
  z.strictObject({
    source: externalIdSource,
    externalIds: z.array(z.string()).min(1).max(500),
  }),
  z.strictObject({
    filter: statementRowFilters.refine(
      (value) => Object.values(value).some((field) => field !== undefined),
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
  /** The row that superseded this one, as `v1:<sha256>` under the same source. */
  supersededByExternalId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type StatementRowUpdateData = z.infer<typeof statementRowUpdateData>;

export const updateStatementRowsInput = z.strictObject({
  selector: statementRowSelector,
  data: statementRowUpdateData,
});
export type UpdateStatementRowsInput = z.infer<typeof updateStatementRowsInput>;

export const deleteStatementRowsInput = z.strictObject({
  selector: statementRowSelector,
});

export const statementRowWriteOut = z.object({
  affected: z.number().int(),
});

/** Shared by the tRPC list procedure and the MCP tool, so they cannot drift. */
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
  amountTotal: z.number(),
  unmatchedAmount: z.number(),
});

export const statementImportListOut = z.object({
  data: z.array(statementImportOut),
  count: z.number().int(),
});
