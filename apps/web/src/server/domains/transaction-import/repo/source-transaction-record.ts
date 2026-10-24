import type { ActorContext } from "@cubby/schemas/context";
import { financialAccountSourceAliases } from "@cubby/schemas/financial-account";
import type { TransactionImportId } from "@cubby/schemas/identifiers";
import type {
  FindSourceTransactionRecordDriftInput,
  RecordSourceTransactionRecordsInput,
  SourceTransactionRecordDriftCandidate,
  SourceTransactionRecordLegacyFilters,
  SourceTransactionRecordSelector,
  UpdateSourceTransactionRecordsInput,
} from "@cubby/schemas/source-transaction-record";
import { sourceTransactionRecordMatchState } from "@cubby/schemas/source-transaction-record";
import { generateShortcode } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  formatSearchTerm,
  notDeleted,
  rangeConditions,
  unwrapDb,
  withTransaction,
  databaseForTransaction,
} from "~/server/db/helpers";
import {
  financialAccount,
  transactionImport,
  transactionImportRecord,
  sourceTransactionRecord,
} from "~/server/db/schema";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import {
  sourceTransactionRecordExternalId,
  sourceTransactionRecordOccurrenceId,
} from "~/server/domains/transaction-import/repo/source-transaction-record-identity";
import {
  CHARGE_STATE,
  LIVE_REFS,
  chargeKeyOf,
} from "~/server/domains/transaction-import/repo/statement-charge";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";
import {
  insertPayloadsWithIdentities,
  isEntityShortcodeCollision,
} from "~/server/entity-kernel/repo/entity-identity-writer";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
import { ensureExternalSources } from "~/server/generic/entity-links/repo/entity-external-ids";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { canonicalJson, jsonSnapshot } from "~/server/lib/canonical-json";

import { auditEvidenceRows, evidenceChanges } from "./intake-audit";
import { assertSourceTransactionRecordSupersessionAllowed } from "./source-transaction-record-lifecycle";

// `cs` carries the charge-level state: repeated observations of one charge
// inherit each other's ignore, supersession and match.
const FROM_WITH_REFS = sql`FROM "SourceTransactionRecord"
  LEFT JOIN ${LIVE_REFS} lr
    ON lr.source = "SourceTransactionRecord"."source"
   AND lr."externalId" = "SourceTransactionRecord"."externalId"
  LEFT JOIN ${CHARGE_STATE} cs
    ON cs.source = "SourceTransactionRecord"."source"
   AND cs."chargeKey" = ${chargeKeyOf('"SourceTransactionRecord"')}`;

const matchStateSql = sql<string>`CASE
  WHEN cs.ignored THEN 'ignored'
  WHEN cs.superseded THEN 'superseded'
  WHEN COALESCE(lr.shortcode, cs.shortcode) IS NOT NULL THEN 'matched'
  ELSE 'unmatched'
END`;

const importFingerprint = sql<string>`(
  SELECT si.fingerprint FROM "TransactionImport" si
  WHERE si.id = "SourceTransactionRecord"."batchId"
)`;

type SourceTransactionRecordSqlValue = string | number | Date | null;
/**
 * The reads run as raw SQL, so values arrive as the pg driver types them rather
 * than as drizzle's column modes: timestamps and `date` columns come back as
 * Date objects, numerics as strings. Coerce here so the output contract is the
 * same whichever way a row was fetched.
 */
const asDate = (value: SourceTransactionRecordSqlValue): Date =>
  value instanceof Date ? value : new Date(String(value));

const asPlainDate = (value: SourceTransactionRecordSqlValue): string => {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
};

const observedInImport = (fingerprint: string) => sql`EXISTS (
  SELECT 1 FROM ${transactionImportMembers} member
  JOIN "TransactionImport" si ON si.id = member."importId"
  WHERE member."statementRowId" = "SourceTransactionRecord".id
    AND si.fingerprint = ${fingerprint}
    AND si.source = "SourceTransactionRecord".source AND si."deletedAt" IS NULL
)`;

const buildConditions = (
  filters: SourceTransactionRecordLegacyFilters,
): SQL[] => {
  const conditions: SQL[] = [notDeleted(sourceTransactionRecord)];
  if (filters.source)
    conditions.push(eq(sourceTransactionRecord.source, filters.source));
  // Addressed by the export's client-supplied fingerprint, never its uuid: a
  // uuid must not reach a URL or an MCP payload.
  if (filters.importFingerprint)
    conditions.push(observedInImport(filters.importFingerprint));
  // Filtered by the account's public shortcode, resolved inline. An unknown
  // code yields NULL and therefore matches nothing, rather than widening to an
  // unfiltered query.
  if (filters.accountId)
    conditions.push(
      sql`${sourceTransactionRecord.accountId} = (
        SELECT fa.id FROM "FinancialAccount" fa
        WHERE fa.shortcode = ${filters.accountId} AND fa."deletedAt" IS NULL
      )`,
    );
  if (filters.sourceCategory)
    conditions.push(
      eq(sourceTransactionRecord.sourceCategory, filters.sourceCategory),
    );
  if (filters.disposition)
    conditions.push(
      eq(sourceTransactionRecord.disposition, filters.disposition),
    );
  if (filters.dispositionReason)
    conditions.push(
      eq(sourceTransactionRecord.dispositionReason, filters.dispositionReason),
    );
  if (filters.matchState)
    conditions.push(sql`${matchStateSql} = ${filters.matchState}`);
  if (filters.dateFrom)
    conditions.push(
      sql`${sourceTransactionRecord.statementDate} >= ${filters.dateFrom}`,
    );
  if (filters.dateTo)
    conditions.push(
      sql`${sourceTransactionRecord.statementDate} <= ${filters.dateTo}`,
    );
  conditions.push(
    ...rangeConditions(
      sourceTransactionRecord.amount,
      filters,
      "amount",
    ).filter((c): c is SQL => c !== undefined),
  );
  if (filters.search) {
    const search = formatSearchTerm(
      sourceTransactionRecord.rawDescription,
      filters.search,
    );
    if (search) conditions.push(search);
  }
  return conditions;
};

export async function getSourceTransactionRecordSummary(
  db: Database,
  filters: SourceTransactionRecordLegacyFilters,
) {
  const where = and(...buildConditions(filters))!;
  const { rows } = await unwrapDb(db).execute<{
    total: number;
    matched: number;
    unmatched: number;
    ignored: number;
    superseded: number;
    amountTotal: string;
    matchedAmount: string;
    unmatchedAmount: string;
    ignoredAmount: string;
    supersededAmount: string;
    unmatchedCharges: number;
  }>(sql`
    SELECT
      count(*)::int AS total,
      COALESCE(sum(amount), 0) AS "amountTotal",
      ${sql.join(
        sourceTransactionRecordMatchState.options.map(
          (state) => sql`
            count(*) FILTER (WHERE ms = ${state})::int AS ${sql.identifier(state)},
            COALESCE(sum(amount) FILTER (WHERE ms = ${state}), 0) AS ${sql.identifier(`${state}Amount`)}`,
        ),
        sql`,`,
      )},
      count(DISTINCT charge) FILTER (WHERE ms = ${sourceTransactionRecordMatchState.enum.unmatched})::int AS "unmatchedCharges"
    FROM (
      SELECT ${matchStateSql} AS ms, ${sourceTransactionRecord.amount} AS amount,
        "SourceTransactionRecord".source || ':' || ${chargeKeyOf('"SourceTransactionRecord"')} AS charge
      ${FROM_WITH_REFS}
      WHERE ${where}
    ) t
  `);
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    matched: Number(row?.matched ?? 0),
    unmatched: Number(row?.unmatched ?? 0),
    ignored: Number(row?.ignored ?? 0),
    superseded: Number(row?.superseded ?? 0),
    amountTotal: Number(row?.amountTotal ?? 0),
    matchedAmount: Number(row?.matchedAmount ?? 0),
    unmatchedAmount: Number(row?.unmatchedAmount ?? 0),
    ignoredAmount: Number(row?.ignoredAmount ?? 0),
    supersededAmount: Number(row?.supersededAmount ?? 0),
    unmatchedCharges: Number(row?.unmatchedCharges ?? 0),
  };
}

const storedRowCount = async (
  tx: DrizzleTransaction,
  batchId: TransactionImportId,
): Promise<number> => {
  const result = await unwrapDb(tx).execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM ${transactionImportMembers} member
    JOIN "SourceTransactionRecord" sr ON sr.id = member."statementRowId" AND sr."deletedAt" IS NULL
    WHERE member."importId" = ${batchId}
  `);
  return Number(result.rows[0]?.count ?? 0);
};

async function insertStatementEvidence(
  tx: DrizzleTransaction,
  rows: Omit<typeof sourceTransactionRecord.$inferInsert, "shortcode">[],
) {
  if (!rows.length) return [];
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await unwrapDb(tx).transaction((nested) =>
        insertPayloadsWithIdentities(
          nested,
          sourceTransactionRecord,
          "sourceTransactionRecord",
          rows.map((row) => ({
            ...row,
            shortcode: generateShortcode("sourceTransactionRecord"),
          })),
        ),
      );
    } catch (error) {
      if (
        !isEntityShortcodeCollision(error, "SourceTransactionRecord") ||
        attempt === 9
      )
        throw error;
    }
  }
  throw new Error("Failed to mint financial evidence identities");
}

/**
 * Advisory only. An un-normalized Copilot or Apple Card export is almost
 * entirely positive here, and every one of its rows will have hashed to a
 * fresh identity that can never match. Warning after the write is still
 * worth it: it surfaces the mistake at 500 rows instead of 15,000 — and a
 * `dryRun` or CSV preview surfaces it before any of them.
 */
function statementSignWarning(
  rows: ReadonlyArray<{ providerAmount: number }>,
): string | null {
  const positive = rows.filter((row) => row.providerAmount > 0).length;
  return rows.length >= 20 && positive / rows.length > 0.9
    ? `${positive} of ${rows.length} rows have a positive providerAmount. ` +
        "Charges must be submitted negative — if this export signs them " +
        "positive (Copilot, Apple Card), the rows just recorded carry " +
        "identities that can never match a transaction. Legitimate if this " +
        "batch really is income or refunds."
    : null;
}

type RecordedMember = Pick<
  typeof sourceTransactionRecord.$inferSelect,
  | "id"
  | "legacyExternalId"
  | "chargeKey"
  | "rowPosition"
  | "externalId"
  | "providerTransactionId"
>;

function retainedCollectionObservation({
  priorMembers,
  row,
  externalId,
  legacyExternalId,
}: {
  priorMembers: readonly RecordedMember[];
  row: RecordSourceTransactionRecordsInput["rows"][number];
  externalId: string | undefined;
  legacyExternalId: string;
}) {
  // Physical identity wins even when historical keys were mispositioned.
  // The immutable-evidence check must refuse a conflict, never guess by content.
  const exact = priorMembers.find((prior) => prior.externalId === externalId);
  if (exact) return exact;
  const candidates = priorMembers.filter((prior) =>
    row.rowPosition !== undefined
      ? prior.rowPosition === row.rowPosition
      : prior.providerTransactionId === null &&
        (prior.legacyExternalId ?? prior.externalId) === legacyExternalId,
  );
  const [candidate] = candidates;
  if (
    candidates.length > 1 ||
    (candidate &&
      row.rowPosition === undefined &&
      candidate.rowPosition !== null) ||
    (!candidate &&
      row.rowPosition !== undefined &&
      priorMembers.some(
        (prior) =>
          prior.rowPosition === null &&
          prior.providerTransactionId === null &&
          (prior.legacyExternalId ?? prior.externalId) === legacyExternalId,
      ))
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Retained collection observations require distinct physical positions to resolve their identity.",
    );
  return candidate;
}

/** Source identity and immutable observation derivation are independent of booking. */
async function prepareStatementObservations(
  tx: DrizzleTransaction,
  input: RecordSourceTransactionRecordsInput,
  observedAt: Date,
  priorMembers: readonly RecordedMember[],
) {
  const { source } = input.import;
  const providerIds = input.rows.flatMap((row) =>
    row.providerTransactionId ? [row.providerTransactionId] : [],
  );
  const previousProviderRows = providerIds.length
    ? await unwrapDb(tx)
        .select()
        .from(sourceTransactionRecord)
        .where(
          and(
            eq(sourceTransactionRecord.source, source),
            inArray(sourceTransactionRecord.providerTransactionId, providerIds),
            notDeleted(sourceTransactionRecord),
          ),
        )
    : [];
  const retainedAccountIds = previousProviderRows.length
    ? await unwrapDb(tx)
        .select({
          chargeKey: sourceTransactionRecord.chargeKey,
          providerAccountId: sourceTransactionRecord.providerAccountId,
        })
        .from(sourceTransactionRecord)
        .where(
          and(
            eq(sourceTransactionRecord.source, source),
            inArray(sourceTransactionRecord.chargeKey, [
              ...new Set(previousProviderRows.map((prior) => prior.chargeKey)),
            ]),
          ),
        )
    : [];
  const accounts = previousProviderRows.length
    ? await unwrapDb(tx)
        .select({
          id: financialAccount.id,
          aliases: financialAccount.sourceAliases,
        })
        .from(financialAccount)
        .where(notDeleted(financialAccount))
    : [];
  const normalizedAlias = (value: string) =>
    value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const coverage = input.import.coverage;
  if (
    coverage &&
    input.rows.some(
      (row) =>
        (row.providerAccountId ?? row.accountDescriptor) !== coverage.account ||
        row.statementDate < coverage.from ||
        row.statementDate > coverage.to,
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Every observation must belong to the declared account and date window.",
    );
  const rows = [];
  for (const row of [...input.rows].sort(
    (a, b) => (a.rowPosition ?? 0) - (b.rowPosition ?? 0),
  )) {
    const legacyExternalId = await sourceTransactionRecordExternalId({
      source,
      account: row.accountDescriptor,
      date: row.statementDate,
      amount: row.providerAmount,
      originalStatement: row.rawDescription,
    });
    // A newly supplied provider ID cannot silently give retained ID-less evidence another charge owner.
    if (
      row.providerTransactionId &&
      priorMembers.some(
        (prior) =>
          prior.providerTransactionId === null &&
          ((row.rowPosition !== undefined &&
            prior.rowPosition === row.rowPosition) ||
            (prior.rowPosition === null &&
              (prior.legacyExternalId ?? prior.externalId) ===
                legacyExternalId)),
      )
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A provider identity overlaps ID-less evidence in this retained collection. Resolve its source identity before replaying.",
      );
    const providerAccountId = row.providerAccountId ?? null;
    let chargeKey = row.providerTransactionId
      ? `provider:${await sha256Hex(JSON.stringify([source, providerAccountId ?? row.accountDescriptor, row.providerTransactionId]))}`
      : row.rowPosition !== undefined
        ? await sourceTransactionRecordOccurrenceId(
            source,
            input.import.fingerprint,
            row.rowPosition,
          )
        : undefined;
    if (row.providerTransactionId) {
      const predecessors = previousProviderRows.filter((prior) => {
        if (prior.providerTransactionId !== row.providerTransactionId)
          return false;
        // An old null account ID cannot bridge past a later known account.
        const knownIds = new Set(
          retainedAccountIds
            .filter((retained) => retained.chargeKey === prior.chargeKey)
            .flatMap((retained) =>
              retained.providerAccountId ? [retained.providerAccountId] : [],
            ),
        );
        if (
          knownIds.size > 1 ||
          (providerAccountId !== null &&
            [...knownIds].some((id) => id !== providerAccountId))
        )
          return false;
        if (providerAccountId && prior.providerAccountId)
          return providerAccountId === prior.providerAccountId;
        if (
          normalizedAlias(prior.accountDescriptor) ===
          normalizedAlias(row.accountDescriptor)
        )
          return true;
        return (
          providerAccountId !== null &&
          accounts.some((account) => {
            const aliases = financialAccountSourceAliases.parse(
              account.aliases,
            );
            return (
              aliases.some(
                (alias) =>
                  alias.source === source &&
                  alias.externalAccountId === providerAccountId,
              ) &&
              (prior.accountId === account.id ||
                aliases.some(
                  (alias) =>
                    alias.source === source &&
                    normalizedAlias(alias.alias) ===
                      normalizedAlias(prior.accountDescriptor),
                ))
            );
          })
        );
      });
      const keys = [...new Set(predecessors.map((prior) => prior.chargeKey))];
      if (keys.length > 1)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "This provider identity has ambiguous historical account evidence; resolve its charge identity before importing a revision.",
        );
      if (keys[0]) chargeKey = keys[0];
    }
    let externalId =
      row.providerTransactionId && chargeKey !== undefined
        ? `v3:${await sha256Hex(
            canonicalJson({
              chargeKey,
              providerAccountId,
              accountDescriptor: row.accountDescriptor,
              date: row.statementDate,
              amount: row.providerAmount,
              merchant: row.merchant,
              description: row.rawDescription,
              category: row.sourceCategory,
              status: row.providerStatus,
              notes: row.providerNotes,
              data: row.providerData ?? null,
            }),
          )}`
        : row.rowPosition !== undefined
          ? await sourceTransactionRecordOccurrenceId(
              source,
              input.import.fingerprint,
              row.rowPosition,
            )
          : undefined;
    if (!row.providerTransactionId) {
      const retained = retainedCollectionObservation({
        priorMembers,
        row,
        externalId,
        legacyExternalId,
      });
      if (retained) {
        externalId = retained.externalId;
        chargeKey = retained.chargeKey;
      }
    }
    // Retained membership can replay a historical identity; new observations
    // need a provider identity or a physical position to preserve multiplicity.
    if (!externalId || !chargeKey)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "New observations require a provider transaction ID or a stable physical row position.",
      );
    rows.push({
      ...row,
      source,
      externalId,
      chargeKey,
      legacyExternalId,
      providerAccountId,
      providerTransactionId: row.providerTransactionId ?? null,
      providerData: row.providerData ?? null,
      amount: -row.providerAmount,
      current: true,
      lastObservedAt: observedAt,
    });
  }
  if (
    new Set(rows.map((row) => row.chargeKey)).size !== rows.length ||
    new Set(rows.map((row) => row.externalId)).size !== rows.length
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Repeated indistinguishable observations require distinct physical positions.",
    );
  if (
    rows.some((row) =>
      priorMembers.some(
        (prior) =>
          prior.chargeKey === row.chargeKey &&
          prior.externalId !== row.externalId,
      ),
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "One collection cannot contain contradictory revisions of the same provider record.",
    );
  return rows;
}

/** Completion and source absence are persisted proofs, independent of booking. */
async function completeEvidenceCollection(
  tx: DrizzleTransaction,
  input: RecordSourceTransactionRecordsInput,
  batchId: TransactionImportId,
  existingBatch:
    | Pick<typeof transactionImport.$inferSelect, "completedAt">
    | undefined,
  rows: Awaited<ReturnType<typeof prepareStatementObservations>>,
  rowCountStored: number,
  observedAt: Date,
) {
  const { source } = input.import;
  let completed = existingBatch?.completedAt != null;
  if (input.complete && !completed) {
    if (
      !input.import.coverage ||
      input.import.rowCountDeclared === null ||
      rowCountStored !== input.import.rowCountDeclared
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Completion requires explicit account/window coverage and every declared observation, including zero-value records.",
      );
    completed = true;
    await unwrapDb(tx)
      .update(transactionImport)
      .set({ completedAt: new Date() })
      .where(eq(transactionImport.id, batchId));
  }
  let withdrawn = 0;
  const withdrawnChargeKeys: string[] = [];
  if (input.confirmedWithdrawals.length) {
    const coverage = input.import.coverage;
    if (
      !completed ||
      !coverage ||
      coverage.visibility !== "all" ||
      rowCountStored !== input.import.rowCountDeclared
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Withdrawals require a completed, rechecked account window.",
      );
    const candidates = await unwrapDb(tx)
      .select()
      .from(sourceTransactionRecord)
      .where(
        and(
          eq(sourceTransactionRecord.source, source),
          eq(sourceTransactionRecord.current, true),
          notDeleted(sourceTransactionRecord),
          inArray(
            sourceTransactionRecord.providerTransactionId,
            input.confirmedWithdrawals,
          ),
          sql`COALESCE(${sourceTransactionRecord.providerAccountId}, ${sourceTransactionRecord.accountDescriptor}) = ${coverage.account}`,
        ),
      );
    for (const row of candidates) {
      if (
        row.statementDate < coverage.from ||
        row.statementDate > coverage.to ||
        row.lastObservedAt > observedAt ||
        rows.some(
          (incoming) =>
            incoming.providerTransactionId === row.providerTransactionId,
        ) ||
        (
          await unwrapDb(tx)
            .select({ id: transactionImportRecord.statementRowId })
            .from(transactionImportRecord)
            .where(
              and(
                eq(transactionImportRecord.importId, batchId),
                eq(transactionImportRecord.statementRowId, row.id),
              ),
            )
            .limit(1)
        ).length
      )
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "The claimed removal is still observed, newer, or outside this collection's scope.",
        );
      if (row.withdrawnAt === null) {
        await unwrapDb(tx)
          .update(sourceTransactionRecord)
          .set({
            withdrawnAt: observedAt,
            withdrawalImportId: batchId,
            lastObservedAt: observedAt,
          })
          .where(eq(sourceTransactionRecord.id, row.id));
        withdrawn += 1;
        withdrawnChargeKeys.push(row.chargeKey);
      }
    }
  }
  return { completed, withdrawn, withdrawnChargeKeys };
}

/**
 * Retain source observations and guarded corrections to existing automatic bookings.
 * New transaction discovery runs through the existing Sweep. The server derives every
 * `externalId` so a client cannot mint an identity that disagrees with the one
 * settlement-reference matching depends on.
 *
 * Idempotent — re-submitting an export inserts nothing. Pass `dryRun` to learn
 * what a real call would do without creating the batch or the rows.
 */
const importAuditColumns = {
  id: transactionImport.id,
  shortcode: transactionImport.shortcode,
  source: transactionImport.source,
  label: transactionImport.label,
  fingerprint: transactionImport.fingerprint,
  dateKind: transactionImport.dateKind,
  observedAt: transactionImport.observedAt,
  coverage: transactionImport.coverage,
  rowCountDeclared: transactionImport.rowCountDeclared,
  completedAt: transactionImport.completedAt,
  createdAt: transactionImport.createdAt,
  updatedAt: transactionImport.updatedAt,
};

export async function recordSourceTransactionRecords(
  db: Database,
  input: RecordSourceTransactionRecordsInput,
  actor: ActorContext,
) {
  const { source } = input.import;
  return withTransaction(
    db,
    async (tx) => {
      // One source's current heads and completed snapshots advance together.
      await lockFinancialEvidenceKeys(tx, "transaction-ref", [
        `intake:${source}`,
      ]);
      const [existingBatch] = await unwrapDb(tx)
        .select(importAuditColumns)
        .from(transactionImport)
        .where(
          and(
            eq(transactionImport.source, source),
            eq(transactionImport.fingerprint, input.import.fingerprint),
            notDeleted(transactionImport),
          ),
        )
        .limit(1);
      const observedAt = input.import.observedAt
        ? new Date(input.import.observedAt)
        : (existingBatch?.observedAt ?? new Date());
      if (
        existingBatch &&
        (existingBatch.observedAt.getTime() !== observedAt.getTime() ||
          canonicalJson(jsonSnapshot.parse(existingBatch.coverage)) !==
            canonicalJson(input.import.coverage ?? null) ||
          existingBatch.rowCountDeclared !== input.import.rowCountDeclared)
      )
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "An evidence collection's scope, time and declared count are immutable. Resume its original request.",
        );
      const priorMembers = existingBatch
        ? await unwrapDb(tx)
            .select({
              id: sourceTransactionRecord.id,
              legacyExternalId: sourceTransactionRecord.legacyExternalId,
              chargeKey: sourceTransactionRecord.chargeKey,
              rowPosition: sourceTransactionRecord.rowPosition,
              externalId: sourceTransactionRecord.externalId,
              providerTransactionId:
                sourceTransactionRecord.providerTransactionId,
            })
            .from(transactionImportRecord)
            .innerJoin(
              sourceTransactionRecord,
              eq(
                sourceTransactionRecord.id,
                transactionImportRecord.statementRowId,
              ),
            )
            .where(eq(transactionImportRecord.importId, existingBatch.id))
        : [];
      const rows = await prepareStatementObservations(
        tx,
        input,
        observedAt,
        priorMembers,
      );
      const ids = rows.map((row) => row.externalId);
      const stored = ids.length
        ? await unwrapDb(tx)
            .select()
            .from(sourceTransactionRecord)
            .where(
              and(
                eq(sourceTransactionRecord.source, source),
                inArray(sourceTransactionRecord.externalId, ids),
                notDeleted(sourceTransactionRecord),
              ),
            )
        : [];
      for (const incoming of rows) {
        const saved = stored.find(
          (row) => row.externalId === incoming.externalId,
        );
        if (
          saved &&
          evidenceChanges(
            {
              accountDescriptor: saved.accountDescriptor,
              statementDate: saved.statementDate,
              providerAmount: saved.providerAmount,
              rawDescription: saved.rawDescription,
              rowPosition: incoming.providerTransactionId
                ? null
                : saved.rowPosition,
              providerTransactionId: saved.providerTransactionId,
              providerAccountId: saved.providerAccountId,
              providerData: saved.providerData,
              merchant: saved.merchant,
              sourceCategory: saved.sourceCategory,
              providerStatus: saved.providerStatus,
              providerNotes: saved.providerNotes,
            },
            {
              accountDescriptor: incoming.accountDescriptor,
              statementDate: incoming.statementDate,
              providerAmount: incoming.providerAmount,
              rawDescription: incoming.rawDescription,
              rowPosition: incoming.providerTransactionId
                ? null
                : (incoming.rowPosition ?? null),
              providerTransactionId: incoming.providerTransactionId,
              providerAccountId: incoming.providerAccountId,
              providerData: incoming.providerData,
              merchant: incoming.merchant,
              sourceCategory: incoming.sourceCategory,
              providerStatus: incoming.providerStatus,
              providerNotes: incoming.providerNotes,
            },
          )
        )
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "An observation identity cannot change its original evidence.",
          );
      }
      const retainedHeads = rows.length
        ? await unwrapDb(tx)
            .select()
            .from(sourceTransactionRecord)
            .where(
              and(
                eq(sourceTransactionRecord.source, source),
                inArray(
                  sourceTransactionRecord.chargeKey,
                  rows.map((row) => row.chargeKey),
                ),
                eq(sourceTransactionRecord.current, true),
                // includes-deleted: a deleted newer head still prevents an old import replay from activating its predecessor.
              ),
            )
        : [];
      const heads = retainedHeads.filter((head) => head.deletedAt === null);
      const novel = rows.filter(
        (row) => !stored.some((saved) => saved.externalId === row.externalId),
      );
      const revised = rows.filter((row) =>
        heads.some(
          (head) =>
            head.chargeKey === row.chargeKey &&
            (head.externalId !== row.externalId || head.withdrawnAt !== null) &&
            head.lastObservedAt <= observedAt,
        ),
      );
      const memberIds = new Set(priorMembers.map((row) => row.id));
      if (
        existingBatch?.completedAt &&
        (novel.length || stored.some((row) => !memberIds.has(row.id)))
      )
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "A completed collection cannot admit additional observations; start a new collection.",
        );
      const refreshed = rows.filter((row) =>
        heads.some(
          (head) =>
            head.chargeKey === row.chargeKey &&
            head.externalId === row.externalId &&
            head.withdrawnAt === null &&
            head.lastObservedAt < observedAt,
        ),
      );
      const alreadyInThisBatch = stored.filter((row) =>
        memberIds.has(row.id),
      ).length;
      const base = {
        batchId: existingBatch?.id ?? null,
        batchCreated: false,
        dryRun: input.dryRun,
        inserted: novel.length,
        unchanged: rows.length - novel.length,
        alreadyInThisBatch,
        alreadyInAnotherBatch: stored.length - alreadyInThisBatch,
        rowCountStored: priorMembers.length,
        completed: existingBatch?.completedAt != null,
        revised: revised.length,
        refreshed: refreshed.length,
        withdrawn: 0,
        correctionReviews: [],
        signWarning: statementSignWarning(rows),
      };
      if (input.dryRun) return base;
      await ensureExternalSources(tx, [source]);
      const auditScope = and(
        eq(sourceTransactionRecord.source, source),
        notDeleted(sourceTransactionRecord),
        or(
          rows.length
            ? inArray(
                sourceTransactionRecord.chargeKey,
                rows.map((row) => row.chargeKey),
              )
            : undefined,
          input.confirmedWithdrawals.length
            ? inArray(
                sourceTransactionRecord.providerTransactionId,
                input.confirmedWithdrawals,
              )
            : undefined,
        ) ?? sql`false`,
      );
      const beforeRows = await unwrapDb(tx)
        .select()
        .from(sourceTransactionRecord)
        .where(auditScope);
      const batch =
        existingBatch ??
        (await insertWithShortcode(tx, "transactionImport", {
          source,
          label: input.import.label,
          fingerprint: input.import.fingerprint,
          dateKind: input.import.dateKind,
          rowCountDeclared: input.import.rowCountDeclared,
          notes: input.import.notes,
          observedAt,
          coverage: input.import.coverage ?? null,
        }));
      const batchId = batch.id;
      if (!batchId)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Failed to record financial evidence collection.",
        );
      for (const row of rows) {
        const newer = retainedHeads.some(
          (head) =>
            head.chargeKey === row.chargeKey &&
            (head.lastObservedAt > observedAt ||
              (head.deletedAt !== null &&
                head.externalId !== row.externalId &&
                head.lastObservedAt >= observedAt) ||
              (head.withdrawnAt !== null && head.withdrawnAt >= observedAt)),
        );
        if (newer) row.current = false;
        else
          await unwrapDb(tx)
            .update(sourceTransactionRecord)
            .set({ current: false })
            .where(
              and(
                eq(sourceTransactionRecord.source, source),
                eq(sourceTransactionRecord.chargeKey, row.chargeKey),
                eq(sourceTransactionRecord.current, true),
                notDeleted(sourceTransactionRecord),
                sql`${sourceTransactionRecord.externalId} <> ${row.externalId}`,
              ),
            );
      }
      if (novel.length)
        await insertStatementEvidence(
          tx,
          novel.map((row) => {
            const head = heads.find((head) => head.chargeKey === row.chargeKey);
            return {
              ...row,
              batchId,
              legacyReference:
                head?.legacyReference ??
                (row.chargeKey === row.legacyExternalId
                  ? row.legacyExternalId
                  : null),
              accountId: head?.accountId ?? null,
              disposition: head?.disposition ?? "open",
              dispositionReason: head?.dispositionReason ?? null,
              dispositionNote: head?.dispositionNote ?? null,
            };
          }),
        );
      for (const row of rows.filter((candidate) => candidate.current))
        await unwrapDb(tx)
          .update(sourceTransactionRecord)
          .set({
            current: true,
            withdrawnAt: null,
            withdrawalImportId: null,
            lastObservedAt: observedAt,
          })
          .where(
            and(
              eq(sourceTransactionRecord.source, source),
              eq(sourceTransactionRecord.externalId, row.externalId),
              notDeleted(sourceTransactionRecord),
              sql`${sourceTransactionRecord.lastObservedAt} <= ${observedAt.toISOString()} AND (${sourceTransactionRecord.withdrawnAt} IS NULL OR ${sourceTransactionRecord.withdrawnAt} < ${observedAt.toISOString()}) AND (${sourceTransactionRecord.lastObservedAt} < ${observedAt.toISOString()} OR NOT ${sourceTransactionRecord.current} OR ${sourceTransactionRecord.withdrawnAt} IS NOT NULL)`,
            ),
          );
      const retained = ids.length
        ? await unwrapDb(tx)
            .select({ id: sourceTransactionRecord.id })
            .from(sourceTransactionRecord)
            .where(
              and(
                eq(sourceTransactionRecord.source, source),
                inArray(sourceTransactionRecord.externalId, ids),
                notDeleted(sourceTransactionRecord),
              ),
            )
        : [];
      const addedMembers = retained.length
        ? await unwrapDb(tx)
            .insert(transactionImportRecord)
            .values(
              retained.map((row) => ({
                importId: batchId,
                statementRowId: row.id,
              })),
            )
            .onConflictDoNothing({
              target: [
                transactionImportRecord.importId,
                transactionImportRecord.statementRowId,
              ],
            })
            .returning({
              statementRowId: transactionImportRecord.statementRowId,
            })
        : [];
      const rowCountStored = await storedRowCount(tx, batchId);
      const { completed, withdrawn, withdrawnChargeKeys } =
        await completeEvidenceCollection(
          tx,
          input,
          batchId,
          existingBatch,
          rows,
          rowCountStored,
          observedAt,
        );
      if (novel.length || revised.length || withdrawn)
        await recordChange(tx, { kind: "source", categories: [] });
      const afterRows = await unwrapDb(tx)
        .select()
        .from(sourceTransactionRecord)
        .where(auditScope);
      await auditEvidenceRows(
        tx,
        actor,
        "sourceTransactionRecord",
        beforeRows,
        afterRows,
      );
      const [afterBatch] = await unwrapDb(tx)
        .select(importAuditColumns)
        .from(transactionImport)
        .where(eq(transactionImport.id, batchId));
      if (afterBatch) {
        const changes = evidenceChanges(existingBatch, afterBatch) ?? {};
        if (!existingBatch && input.import.notes !== null)
          changes.notes = { from: null, to: input.import.notes };
        if (addedMembers.length)
          changes.records = {
            from: null,
            to: addedMembers.map((member) => member.statementRowId),
          };
        if (Object.keys(changes).length)
          await logAuditEntries(tx, actor, [
            {
              entityKind: "transactionImport",
              entityId: batchId,
              action: existingBatch ? "update" : "create",
              changes,
            },
          ]);
      }
      const { reconcileRecordedFinancialEvidence } =
        await import("./statement-evidence-correction");
      const correctionReviews = await reconcileRecordedFinancialEvidence(
        databaseForTransaction(tx),
        source,
        [
          ...new Set([
            ...revised.map((row) => row.chargeKey),
            ...refreshed.map((row) => row.chargeKey),
            ...withdrawnChargeKeys,
          ]),
        ],
        actor,
      );
      return {
        ...base,
        batchId,
        batchCreated: !existingBatch,
        rowCountStored,
        completed,
        withdrawn,
        correctionReviews,
      };
    },
    { isolationLevel: "serializable" },
  );
}

/**
 * Find charges recorded twice under two identities.
 *
 * The identity hash covers `rawDescription`, so a charge re-exported after its
 * descriptor firms up — `AMAZON MKTPLACE PMTS` → `AMAZON MKTPL*XD8AR9RG3`,
 * `THE HOME DEPOT #1092` → `THE HOME DEPOT #1092 800-466-3337 CA` — hashes to
 * a SECOND identity for money already recorded, a shape found by hand-writing
 * this self-join against a real Monarch export.
 *
 * Detection, not prevention: the hash is stored externally as a transaction's
 * `settlement_ref` EntityExternalId with no back-reference, so changing what it
 * covers would orphan every ref (`source-transaction-record-identity.ts` says so at
 * length). Reporting, not repair: `(accountDescriptor, statementDate,
 * providerAmount)` also matches genuine same-day same-amount pairs, so a
 * candidate is a question. The remedy stays the explicit, per-row
 * `supersededByExternalId` write.
 *
 * Rows already superseded drop out, so the list shrinks as it is worked.
 */
export async function findSourceTransactionRecordDrift(
  db: Database,
  input: FindSourceTransactionRecordDriftInput,
) {
  const conditions: SQL[] = [
    notDeleted(sourceTransactionRecord),
    // An already-linked predecessor is a settled question. Only the predecessor
    // carries the link, so a resolved pair leaves one live row in its group and
    // the `count(*) > 1` gate drops it.
    sql`${sourceTransactionRecord.supersededByRowId} IS NULL`,
  ];
  if (input.source)
    conditions.push(eq(sourceTransactionRecord.source, input.source));
  if (input.dateFrom)
    conditions.push(
      sql`${sourceTransactionRecord.statementDate} >= ${input.dateFrom}`,
    );
  if (input.dateTo)
    conditions.push(
      sql`${sourceTransactionRecord.statementDate} <= ${input.dateTo}`,
    );
  if (input.importFingerprint)
    conditions.push(observedInImport(input.importFingerprint));
  const where = and(...conditions)!;
  // Coexisting rows are distinct purchases even when another export owned one first.
  const unsharedPair = sql`NOT EXISTS (
    SELECT 1 FROM ${transactionImportMembers} left_member
    JOIN ${transactionImportMembers} right_member ON right_member."importId" = left_member."importId"
    WHERE left_member."statementRowId" = a.id AND right_member."statementRowId" = b.id
  )`;
  const sameBatchGate = input.includeSameBatch
    ? sql``
    : sql`HAVING bool_or(${unsharedPair})`;

  // One extra group so `truncated` reports the cut rather than implying the
  // sweep came back clean.
  const probe = input.limit + 1;
  const { rows } = await unwrapDb(db).execute<{
    source: string;
    accountDescriptor: string;
    statementDate: SourceTransactionRecordSqlValue;
    providerAmount: SourceTransactionRecordSqlValue;
    crossBatch: boolean;
    externalId: string;
    rawDescription: string;
    merchant: string | null;
    providerStatus: string | null;
    disposition: string;
    importFingerprint: string;
    createdAt: SourceTransactionRecordSqlValue;
  }>(sql`
    WITH eligible AS (
      SELECT id, source, "chargeKey", "accountDescriptor", "statementDate", "providerAmount", "createdAt"
      FROM "SourceTransactionRecord" WHERE ${where}
    ), drifted AS (
      SELECT a.source, a."accountDescriptor", a."statementDate", a."providerAmount",
             min(least(a."createdAt", b."createdAt")) AS "firstSeen",
             bool_or(${unsharedPair}) AS "crossBatch"
      FROM eligible a
      JOIN eligible b ON a.id < b.id AND a."chargeKey" <> b."chargeKey"
        AND a.source = b.source AND a."accountDescriptor" = b."accountDescriptor"
        AND a."statementDate" = b."statementDate" AND a."providerAmount" = b."providerAmount"
      GROUP BY a.source, a."accountDescriptor", a."statementDate", a."providerAmount"
      ${sameBatchGate}
      ORDER BY "crossBatch" DESC, "firstSeen" DESC
      LIMIT ${probe}
    )
    SELECT "SourceTransactionRecord"."source",
           "SourceTransactionRecord"."accountDescriptor",
           "SourceTransactionRecord"."statementDate",
           "SourceTransactionRecord"."providerAmount",
           d."crossBatch",
           "SourceTransactionRecord"."externalId",
           "SourceTransactionRecord"."rawDescription",
           "SourceTransactionRecord"."merchant",
           "SourceTransactionRecord"."providerStatus",
           "SourceTransactionRecord"."disposition",
           ${importFingerprint} AS "importFingerprint",
           "SourceTransactionRecord"."createdAt"
    FROM "SourceTransactionRecord"
    JOIN drifted d
      ON d."source" = "SourceTransactionRecord"."source"
     AND d."accountDescriptor" = "SourceTransactionRecord"."accountDescriptor"
     AND d."statementDate" = "SourceTransactionRecord"."statementDate"
     AND d."providerAmount" = "SourceTransactionRecord"."providerAmount"
    WHERE ${where}
    ORDER BY d."firstSeen" DESC, "SourceTransactionRecord"."createdAt" ASC,
             "SourceTransactionRecord"."externalId" ASC
  `);

  const byGroup = new Map<string, SourceTransactionRecordDriftCandidate>();
  for (const row of rows) {
    const statementDate = asPlainDate(row.statementDate);
    const providerAmount = Number(row.providerAmount);
    const key = `${row.source}|${row.accountDescriptor}|${statementDate}|${providerAmount}`;
    const group = byGroup.get(key) ?? {
      source: row.source,
      accountDescriptor: row.accountDescriptor,
      statementDate,
      providerAmount,
      crossBatch: row.crossBatch,
      rows: [],
    };
    group.rows.push({
      externalId: row.externalId,
      rawDescription: row.rawDescription,
      merchant: row.merchant,
      providerStatus:
        row.providerStatus === "posted" || row.providerStatus === "pending"
          ? row.providerStatus
          : null,
      disposition: row.disposition === "ignored" ? "ignored" : "open",
      importFingerprint: row.importFingerprint,
      createdAt: asDate(row.createdAt),
    });
    byGroup.set(key, group);
  }

  const candidates = [...byGroup.values()];
  return {
    candidates: candidates.slice(0, input.limit),
    truncated: candidates.length > input.limit,
  };
}

const selectorConditions = (selector: SourceTransactionRecordSelector): SQL => {
  if ("externalIds" in selector)
    return and(
      notDeleted(sourceTransactionRecord),
      eq(sourceTransactionRecord.source, selector.source),
      sql`${sourceTransactionRecord.externalId} IN (${sql.join(
        selector.externalIds.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )!;
  const conditions = buildConditions(selector.filter);
  // The schema's non-empty refine is a fast reject, not the guarantee: it can
  // only see whether a field was *supplied*, while `buildConditions` decides
  // whether a field actually *restricts* — and the two disagree on a supplied
  // but falsy value (`{search: ""}` is defined, yet skipped below). Checking the
  // produced conditions instead of a parallel notion of emptiness is what makes
  // this un-driftable: `buildConditions` always contributes `notDeleted`, so a
  // length of one means nothing narrowed it, and a bulk write addressing every
  // row is never what the caller meant.
  if (conditions.length <= 1)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Selector filter restricts nothing; it would address every statement row.",
    );
  return and(...conditions)!;
};

export async function updateSourceTransactionRecords(
  db: Database,
  input: UpdateSourceTransactionRecordsInput,
  actor: ActorContext,
) {
  const { data, selector } = input;
  return withTransaction(db, async (tx) => {
    const values: Partial<typeof sourceTransactionRecord.$inferInsert> = {};
    if (data.disposition !== undefined) values.disposition = data.disposition;
    if (data.dispositionReason !== undefined)
      values.dispositionReason = data.dispositionReason;
    if (data.dispositionNote !== undefined)
      values.dispositionNote = data.dispositionNote;
    if (data.notes !== undefined) values.notes = data.notes;

    if (data.accountId !== undefined) {
      if (data.accountId === null) values.accountId = null;
      else {
        const [account] = await unwrapDb(tx)
          .select({ id: financialAccount.id })
          .from(financialAccount)
          .where(
            and(
              eq(financialAccount.shortcode, data.accountId),
              notDeleted(financialAccount),
            ),
          )
          .limit(1);
        if (!account)
          throw createAppError(
            "FINANCIAL_ACCOUNT_NOT_FOUND",
            `Financial account ${data.accountId} was not found.`,
          );
        values.accountId = account.id;
      }
    }

    if (data.supersededByExternalId !== undefined) {
      if (data.supersededByExternalId === null) values.supersededByRowId = null;
      else {
        // Superseding is inherently per-row: the successor is a specific row,
        // so pointing a filtered batch at one successor would be a claim about
        // every row in it. Require the explicit shape.
        if (!("externalIds" in selector))
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "supersededByExternalId requires an explicit source/externalIds selector.",
          );
        const [successor] = await unwrapDb(tx)
          .select({ id: sourceTransactionRecord.id })
          .from(sourceTransactionRecord)
          .where(
            and(
              eq(sourceTransactionRecord.source, selector.source),
              eq(
                sourceTransactionRecord.externalId,
                data.supersededByExternalId,
              ),
              notDeleted(sourceTransactionRecord),
            ),
          )
          .limit(1);
        if (!successor)
          throw createAppError(
            "REFERENCED_RECORD_MISSING",
            `No ${selector.source} statement row ${data.supersededByExternalId} to supersede with.`,
          );
        values.supersededByRowId = successor.id;
      }
    }

    if (Object.keys(values).length === 0) return { affected: 0 };

    const before = await unwrapDb(tx)
      .select()
      .from(sourceTransactionRecord)
      .where(selectorConditions(selector));
    if (values.supersededByRowId)
      for (const predecessor of before)
        await assertSourceTransactionRecordSupersessionAllowed(
          tx,
          predecessor,
          values.supersededByRowId,
        );
    const updated = await unwrapDb(tx)
      .update(sourceTransactionRecord)
      .set(values)
      .where(
        and(
          selectorConditions(selector),
          // A repeated reviewed assignment must preserve observation metadata
          // and its row version, including nullable judgments.
          or(
            ...Object.entries(values).map(
              ([column, value]) =>
                sql`${sql.identifier(column)} IS DISTINCT FROM ${value}`,
            ),
          ),
        ),
      )
      .returning();
    await auditEvidenceRows(
      tx,
      actor,
      "sourceTransactionRecord",
      before,
      updated,
    );
    if (updated.length)
      await recordChange(tx, { kind: "source", categories: [] });
    return { affected: updated.length };
  });
}

export {
  sourceTransactionRecordRepository,
  transactionImportRepository,
  listSourceTransactionRecordsRead,
} from "./entity-repositories";
export { assertSourceTransactionRecordDeletionAllowed } from "./source-transaction-record-lifecycle";
