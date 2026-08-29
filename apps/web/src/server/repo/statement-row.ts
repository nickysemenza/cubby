import type { ActorContext } from "@cubby/schemas/context";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { buildTakeSkip } from "@cubby/schemas/pagination";
import type {
  FindStatementRowDriftInput,
  RecordStatementRowsInput,
  StatementRowDriftCandidate,
  StatementRowFilters,
  StatementRowOut,
  StatementRowSelector,
  UpdateStatementRowsInput,
} from "@cubby/schemas/statement-row";
import {
  statementImportOut,
  statementRowOut,
} from "@cubby/schemas/statement-row";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  financialAccount,
  statementImport,
  statementRow,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  formatSearchTerm,
  notDeleted,
  rangeConditions,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  merchantVendorInferences,
  normalizeMerchant,
} from "~/server/repo/merchant-vendor-inference";
import { statementRowExternalId } from "~/server/repo/statement-row-identity";

/**
 * Every live `(source, externalId)` pair, unnested ONCE.
 *
 * This was a correlated `sourceRefs @> jsonb_build_array(...)` probe per row,
 * and that is why this comment is long. The containment operand is built from
 * the outer row, so it is not a constant and the planner cannot use
 * `FinancialTransaction_sourceRefs_gin_idx` — it fell back to a sequential scan
 * of every transaction FOR EVERY ROW. Measured on 33,681 live rows with only
 * two of the summary's six aggregates: 231 seconds and 13.9M buffer hits.
 * Unnesting once and hash-joining is O(refs + rows), so cost scales with
 * FinancialTransaction (~3.4k refs) rather than with StatementRow.
 *
 * LOAD-BEARING, and the guarantee lives in another file: joining without
 * DISTINCT is safe only because `assertSourceRefsAvailable`
 * (repo/financial-transaction.ts) makes `(source, externalId)` globally unique
 * across live transactions. Two transactions claiming one ref would fan this
 * join out and silently duplicate rows.
 */
const LIVE_REFS = sql`(
  SELECT r->>'source' AS source, r->>'externalId' AS "externalId", ft.shortcode
  FROM "FinancialTransaction" ft
  CROSS JOIN LATERAL jsonb_array_elements(ft."sourceRefs") r
  WHERE ft."deletedAt" IS NULL
)`;

const FROM_WITH_REFS = sql`FROM "StatementRow"
  LEFT JOIN ${LIVE_REFS} lr
    ON lr.source = "StatementRow"."source"
   AND lr."externalId" = "StatementRow"."externalId"`;

const matchedTransaction = sql<string | null>`lr.shortcode`;

const matchStateSql = sql<string>`CASE
  WHEN ${statementRow.disposition} = 'ignored' THEN 'ignored'
  WHEN ${statementRow.supersededByRowId} IS NOT NULL THEN 'superseded'
  WHEN lr.shortcode IS NOT NULL THEN 'matched'
  ELSE 'unmatched'
END`;

/**
 * Outer-column references in these subqueries are written out by hand rather
 * than interpolated as drizzle columns, because drizzle renders a column
 * UNQUALIFIED — `"supersededByRowId"`, not `"StatementRow"."supersededByRowId"`.
 * An unqualified name resolves against the subquery's own table first, so the
 * self-join below silently became `successor.id = successor."supersededByRowId"`:
 * never true, always NULL, and no error, because the alias really does have
 * that column. Qualify explicitly whenever a subquery reads the same table.
 */
const accountShortcode = sql<string | null>`(
  SELECT fa.shortcode FROM "FinancialAccount" fa
  WHERE fa.id = "StatementRow"."accountId" AND fa."deletedAt" IS NULL
)`;

const accountNameSql = sql<string | null>`(
  SELECT fa.name FROM "FinancialAccount" fa
  WHERE fa.id = "StatementRow"."accountId" AND fa."deletedAt" IS NULL
)`;

const supersededByExternalId = sql<string | null>`(
  SELECT successor."externalId" FROM "StatementRow" successor
  WHERE successor.id = "StatementRow"."supersededByRowId"
)`;

const importFingerprint = sql<string>`(
  SELECT si.fingerprint FROM "StatementImport" si
  WHERE si.id = "StatementRow"."batchId"
)`;

const columns = {
  source: statementRow.source,
  externalId: statementRow.externalId,
  accountDescriptor: statementRow.accountDescriptor,
  statementDate: statementRow.statementDate,
  amount: statementRow.amount,
  providerAmount: statementRow.providerAmount,
  merchant: statementRow.merchant,
  rawDescription: statementRow.rawDescription,
  sourceCategory: statementRow.sourceCategory,
  providerStatus: statementRow.providerStatus,
  providerNotes: statementRow.providerNotes,
  accountId: statementRow.accountId,
  disposition: statementRow.disposition,
  dispositionReason: statementRow.dispositionReason,
  dispositionNote: statementRow.dispositionNote,
  notes: statementRow.notes,
  createdAt: statementRow.createdAt,
  updatedAt: statementRow.updatedAt,
  accountShortcode,
  accountName: accountNameSql,
  supersededBy: supersededByExternalId,
  importFingerprint,
  matchState: matchStateSql,
  transactionShortcode: matchedTransaction,
} as const;

type StatementRowSqlValue = string | number | Date | null;
type StatementRowRow = {
  [K in keyof typeof columns]: StatementRowSqlValue;
};

/**
 * The reads run as raw SQL, so values arrive as the pg driver types them rather
 * than as drizzle's column modes: timestamps and `date` columns come back as
 * Date objects, numerics as strings. Coerce here so the output contract is the
 * same whichever way a row was fetched.
 */
const asDate = (value: StatementRowSqlValue): Date =>
  value instanceof Date ? value : new Date(String(value));

const asPlainDate = (value: StatementRowSqlValue): string => {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
};

const toOut = (row: StatementRowRow): StatementRowOut =>
  statementRowOut.parse({
    ...row,
    statementDate: asPlainDate(row.statementDate),
    createdAt: asDate(row.createdAt),
    updatedAt: asDate(row.updatedAt),
    amount: Number(row.amount),
    providerAmount: Number(row.providerAmount),
    accountId: row.accountShortcode
      ? parseShortcodeFor("financialAccount", String(row.accountShortcode))
      : null,
    transactionId: row.transactionShortcode
      ? parseShortcodeFor(
          "financialTransaction",
          String(row.transactionShortcode),
        )
      : null,
  });

const buildConditions = (filters: StatementRowFilters): SQL[] => {
  const conditions: SQL[] = [notDeleted(statementRow)];
  if (filters.source) conditions.push(eq(statementRow.source, filters.source));
  // Addressed by the export's client-supplied fingerprint, never its uuid: a
  // uuid must not reach a URL or an MCP payload.
  if (filters.importFingerprint)
    conditions.push(
      sql`${statementRow.batchId} = (
        SELECT si.id FROM "StatementImport" si
        WHERE si.fingerprint = ${filters.importFingerprint}
          AND si.source = "StatementRow"."source" AND si."deletedAt" IS NULL
      )`,
    );
  // Filtered by the account's public shortcode, resolved inline. An unknown
  // code yields NULL and therefore matches nothing, rather than widening to an
  // unfiltered query.
  if (filters.accountId)
    conditions.push(
      sql`${statementRow.accountId} = (
        SELECT fa.id FROM "FinancialAccount" fa
        WHERE fa.shortcode = ${filters.accountId} AND fa."deletedAt" IS NULL
      )`,
    );
  if (filters.sourceCategory)
    conditions.push(eq(statementRow.sourceCategory, filters.sourceCategory));
  if (filters.disposition)
    conditions.push(eq(statementRow.disposition, filters.disposition));
  if (filters.dispositionReason)
    conditions.push(
      eq(statementRow.dispositionReason, filters.dispositionReason),
    );
  if (filters.matchState)
    conditions.push(sql`${matchStateSql} = ${filters.matchState}`);
  if (filters.dateFrom)
    conditions.push(sql`${statementRow.statementDate} >= ${filters.dateFrom}`);
  if (filters.dateTo)
    conditions.push(sql`${statementRow.statementDate} <= ${filters.dateTo}`);
  conditions.push(
    ...rangeConditions(statementRow.amount, filters, "amount").filter(
      (c): c is SQL => c !== undefined,
    ),
  );
  if (filters.search) {
    const search = formatSearchTerm(
      statementRow.rawDescription,
      filters.search,
    );
    if (search) conditions.push(search);
  }
  return conditions;
};

export async function listStatementRows(
  db: Database,
  filters: StatementRowFilters,
  pagination?: PaginationParams,
  sort?: SortParams,
) {
  const where = and(...buildConditions(filters))!;
  const { take, skip } = buildTakeSkip(
    pagination ?? { pageIndex: 0, pageSize: 50 },
  );
  const direction = sort?.direction === "asc" ? asc : desc;
  const orderColumn =
    sort?.orderBy === "amount"
      ? statementRow.amount
      : sort?.orderBy === "accountDescriptor"
        ? statementRow.accountDescriptor
        : sort?.orderBy === "rawDescription"
          ? statementRow.rawDescription
          : sort?.orderBy === "createdAt"
            ? statementRow.createdAt
            : statementRow.statementDate;

  // Raw SQL rather than the drizzle builder because both the projection and the
  // WHERE may reference `lr`, and the count has to see the same join — a count
  // taken without it would disagree with the page whenever `matchState` filters.
  const projection = sql.join(
    Object.entries(columns).map(
      (entry) => sql`${entry[1]} AS ${sql.identifier(entry[0])}`,
    ),
    sql`, `,
  );
  const [data, counted] = await Promise.all([
    unwrapDb(db).execute<StatementRowRow>(sql`
      SELECT ${projection}
      ${FROM_WITH_REFS}
      WHERE ${where}
      -- Tie-broken by id: statementDate alone is not unique, and an unstable
      -- sort silently repeats or skips rows across pages.
      ORDER BY ${direction(orderColumn)}, ${asc(statementRow.id)}
      LIMIT ${take} OFFSET ${skip}
    `),
    unwrapDb(db).execute<{ count: number }>(sql`
      SELECT count(*)::int AS count ${FROM_WITH_REFS} WHERE ${where}
    `),
  ]);
  const output = data.rows.map((row) => toOut(row));
  const eligibleMerchants = output.flatMap((row) =>
    row.matchState === "unmatched" && row.merchant ? [row.merchant] : [],
  );
  const inferences = await merchantVendorInferences(db, eligibleMerchants);
  return {
    data: output.map((row) => ({
      ...row,
      vendorInference:
        row.matchState === "unmatched" && row.merchant
          ? (inferences.get(normalizeMerchant(row.merchant)) ?? {
              status: "none" as const,
              candidates: [],
            })
          : null,
    })),
    count: Number(counted.rows[0]?.count ?? 0),
  };
}

export async function getStatementRowSummary(
  db: Database,
  filters: StatementRowFilters,
) {
  const where = and(...buildConditions(filters))!;
  const { rows } = await unwrapDb(db).execute<{
    total: number;
    matched: number;
    unmatched: number;
    ignored: number;
    superseded: number;
    amountTotal: string;
    unmatchedAmount: string;
  }>(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE ms = 'matched')::int AS matched,
      count(*) FILTER (WHERE ms = 'unmatched')::int AS unmatched,
      count(*) FILTER (WHERE ms = 'ignored')::int AS ignored,
      count(*) FILTER (WHERE ms = 'superseded')::int AS superseded,
      COALESCE(sum(amount), 0) AS "amountTotal",
      COALESCE(sum(amount) FILTER (WHERE ms = 'unmatched'), 0) AS "unmatchedAmount"
    FROM (
      SELECT ${matchStateSql} AS ms, ${statementRow.amount} AS amount
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
    unmatchedAmount: Number(row?.unmatchedAmount ?? 0),
  };
}

const storedRowCount = async (
  tx: DrizzleTransaction,
  batchId: string,
): Promise<number> => {
  const [row] = await unwrapDb(tx)
    .select({ count: sql<number>`count(*)::int` })
    .from(statementRow)
    .where(and(eq(statementRow.batchId, batchId), notDeleted(statementRow)));
  return Number(row?.count ?? 0);
};

/**
 * Record provider rows verbatim. Not an importer: it creates no account, no
 * transaction and no link, and makes no match. The server derives every
 * `externalId` so a client cannot mint an identity that disagrees with the one
 * `sourceRefs` matching depends on.
 *
 * Idempotent — re-submitting an export inserts nothing. Pass `dryRun` to learn
 * what a real call would do without creating the batch or the rows.
 */
export async function recordStatementRows(
  db: Database,
  input: RecordStatementRowsInput,
  // Unused: StatementRow has no `AuditEntityType` — see deleteStatementRows.
  _actor: ActorContext,
) {
  const { source } = input.import;
  const rows = await Promise.all(
    input.rows.map(async (row) => ({
      ...row,
      source,
      externalId: await statementRowExternalId({
        source,
        account: row.accountDescriptor,
        date: row.statementDate,
        amount: row.providerAmount,
        originalStatement: row.rawDescription,
      }),
      // Cubby's convention is outflow-positive; providers sign charges negative.
      amount: -row.providerAmount,
    })),
  );

  // Two provider rows that hash identically are indistinguishable, so only the
  // first can ever be stored. Counted here rather than inferred from the insert
  // count, which cannot tell this apart from "already recorded".
  const idCounts = new Map<string, number>();
  for (const row of rows)
    idCounts.set(row.externalId, (idCounts.get(row.externalId) ?? 0) + 1);
  const indistinguishableDuplicates = rows.length - idCounts.size;
  const rowsOmitted =
    input.import.rowCountDeclared === null
      ? null
      : input.import.rowCountDeclared - rows.length;

  // Advisory only. An un-normalized Copilot or Apple Card export is almost
  // entirely positive here, and every one of its rows will have hashed to a
  // fresh identity that can never match. Warning after the write is still
  // worth it: it surfaces the mistake at 500 rows instead of 15,000 — and a
  // `dryRun` surfaces it before any of them.
  const positive = rows.filter((row) => row.providerAmount > 0).length;
  const signWarning =
    rows.length >= 20 && positive / rows.length > 0.9
      ? `${positive} of ${rows.length} rows have a positive providerAmount. ` +
        "Charges must be submitted negative — if this export signs them " +
        "positive (Copilot, Apple Card), the rows just recorded carry " +
        "identities that can never match a transaction. Legitimate if this " +
        "batch really is income or refunds."
      : null;

  return withTransaction(db, async (tx) => {
    const [existingBatch] = await unwrapDb(tx)
      .select({ id: statementImport.id })
      .from(statementImport)
      .where(
        and(
          eq(statementImport.source, source),
          eq(statementImport.fingerprint, input.import.fingerprint),
          notDeleted(statementImport),
        ),
      )
      .limit(1);

    // Which of these identities the ledger already holds, and under whose
    // batch. `ON CONFLICT DO NOTHING` answers neither question — it reports a
    // count of rows that landed, and the three ways a row can fail to land
    // have three different remedies.
    const distinctIds = [...idCounts.keys()];
    const stored = await unwrapDb(tx)
      .select({
        externalId: statementRow.externalId,
        batchId: statementRow.batchId,
      })
      .from(statementRow)
      .where(
        and(
          eq(statementRow.source, source),
          inArray(statementRow.externalId, distinctIds),
          notDeleted(statementRow),
        ),
      );
    const alreadyInThisBatch = stored.filter(
      (row) => row.batchId === existingBatch?.id,
    ).length;
    const alreadyInAnotherBatch = stored.length - alreadyInThisBatch;
    const novel = distinctIds.length - stored.length;

    if (input.dryRun) {
      return {
        batchId: existingBatch?.id ?? null,
        batchCreated: false,
        dryRun: true,
        inserted: novel,
        unchanged: rows.length - novel,
        alreadyInThisBatch,
        alreadyInAnotherBatch,
        indistinguishableDuplicates,
        rowsOmitted,
        rowCountStored: existingBatch
          ? await storedRowCount(tx, existingBatch.id)
          : 0,
        signWarning,
      };
    }

    const batchId =
      existingBatch?.id ??
      (
        await unwrapDb(tx)
          .insert(statementImport)
          .values({
            source,
            label: input.import.label,
            fingerprint: input.import.fingerprint,
            dateKind: input.import.dateKind,
            rowCountDeclared: input.import.rowCountDeclared,
            notes: input.import.notes,
          })
          .returning({ id: statementImport.id })
      )[0]?.id;
    if (!batchId)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Failed to create statement import batch.",
      );

    const before = await storedRowCount(tx, batchId);
    const inserted = await unwrapDb(tx)
      .insert(statementRow)
      .values(rows.map((row) => ({ ...row, batchId })))
      // The partial unique index is the idempotency mechanism: a re-submitted
      // export is a no-op rather than a conflict, and a row already recorded
      // under a different batch keeps its original batch.
      .onConflictDoNothing({
        target: [statementRow.source, statementRow.externalId],
        where: sql`"StatementRow"."deletedAt" IS NULL`,
      })
      .returning({ id: statementRow.id });

    return {
      batchId,
      batchCreated: !existingBatch,
      dryRun: false,
      inserted: inserted.length,
      unchanged: rows.length - inserted.length,
      alreadyInThisBatch,
      alreadyInAnotherBatch,
      indistinguishableDuplicates,
      rowsOmitted,
      rowCountStored: before + inserted.length,
      signWarning,
    };
  });
}

/**
 * Find charges recorded twice under two identities.
 *
 * The identity hash covers `rawDescription`, so a charge re-exported after its
 * descriptor firms up — `AMAZON MKTPLACE PMTS` → `AMAZON MKTPL*XD8AR9RG3`,
 * `THE HOME DEPOT #1092` → `THE HOME DEPOT #1092 800-466-3337 CA` — hashes to
 * a SECOND identity for money already recorded. 9 of 188 rows in the
 * 2026-08-19 Monarch export were this shape, found by hand-writing this
 * self-join.
 *
 * Detection, not prevention: the hash is stored externally in
 * `FinancialTransaction.sourceRefs` with no back-reference, so changing what it
 * covers would orphan every ref (`statement-row-identity.ts` says so at
 * length). Reporting, not repair: `(accountDescriptor, statementDate,
 * providerAmount)` also matches genuine same-day same-amount pairs, so a
 * candidate is a question. The remedy stays the explicit, per-row
 * `supersededByExternalId` write.
 *
 * Rows already superseded drop out, so the list shrinks as it is worked.
 */
export async function findStatementRowDrift(
  db: Database,
  input: FindStatementRowDriftInput,
) {
  const conditions: SQL[] = [
    notDeleted(statementRow),
    // An already-linked predecessor is a settled question. Only the predecessor
    // carries the link, so a resolved pair leaves one live row in its group and
    // the `count(*) > 1` gate drops it.
    sql`${statementRow.supersededByRowId} IS NULL`,
  ];
  if (input.source) conditions.push(eq(statementRow.source, input.source));
  if (input.dateFrom)
    conditions.push(sql`${statementRow.statementDate} >= ${input.dateFrom}`);
  if (input.dateTo)
    conditions.push(sql`${statementRow.statementDate} <= ${input.dateTo}`);
  if (input.importFingerprint)
    conditions.push(
      sql`${statementRow.batchId} = (
        SELECT si.id FROM "StatementImport" si
        WHERE si.fingerprint = ${input.importFingerprint}
          AND si.source = "StatementRow"."source" AND si."deletedAt" IS NULL
      )`,
    );
  const where = and(...conditions)!;
  // A single export speaks one descriptor vocabulary, so two of its own rows
  // differing only in description are two real charges. Gated in the HAVING
  // rather than filtered after, so `limit` counts findings and not noise.
  const sameBatchGate = input.includeSameBatch
    ? sql``
    : sql`AND count(DISTINCT "batchId") > 1`;

  // One extra group so `truncated` reports the cut rather than implying the
  // sweep came back clean.
  const probe = input.limit + 1;
  const { rows } = await unwrapDb(db).execute<{
    source: string;
    accountDescriptor: string;
    statementDate: StatementRowSqlValue;
    providerAmount: StatementRowSqlValue;
    crossBatch: boolean;
    externalId: string;
    rawDescription: string;
    merchant: string | null;
    providerStatus: string | null;
    disposition: string;
    importFingerprint: string;
    createdAt: StatementRowSqlValue;
  }>(sql`
    WITH drifted AS (
      SELECT "source", "accountDescriptor", "statementDate", "providerAmount",
             min("createdAt") AS "firstSeen",
             count(DISTINCT "batchId") > 1 AS "crossBatch"
      FROM "StatementRow"
      WHERE ${where}
      GROUP BY "source", "accountDescriptor", "statementDate", "providerAmount"
      -- No count(DISTINCT "externalId") gate: the partial unique on
      -- (source, externalId) already makes two live rows two identities.
      HAVING count(*) > 1 ${sameBatchGate}
      -- Cross-batch first: those are the drift, and a bounded sweep must not
      -- spend its limit on coincidences.
      ORDER BY count(DISTINCT "batchId") > 1 DESC, "firstSeen" DESC
      LIMIT ${probe}
    )
    SELECT "StatementRow"."source",
           "StatementRow"."accountDescriptor",
           "StatementRow"."statementDate",
           "StatementRow"."providerAmount",
           d."crossBatch",
           "StatementRow"."externalId",
           "StatementRow"."rawDescription",
           "StatementRow"."merchant",
           "StatementRow"."providerStatus",
           "StatementRow"."disposition",
           ${importFingerprint} AS "importFingerprint",
           "StatementRow"."createdAt"
    FROM "StatementRow"
    JOIN drifted d
      ON d."source" = "StatementRow"."source"
     AND d."accountDescriptor" = "StatementRow"."accountDescriptor"
     AND d."statementDate" = "StatementRow"."statementDate"
     AND d."providerAmount" = "StatementRow"."providerAmount"
    WHERE ${where}
    ORDER BY d."firstSeen" DESC, "StatementRow"."createdAt" ASC,
             "StatementRow"."externalId" ASC
  `);

  const byGroup = new Map<string, StatementRowDriftCandidate>();
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

const selectorConditions = (selector: StatementRowSelector): SQL => {
  if ("externalIds" in selector)
    return and(
      notDeleted(statementRow),
      eq(statementRow.source, selector.source),
      sql`${statementRow.externalId} IN (${sql.join(
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

export async function updateStatementRows(
  db: Database,
  input: UpdateStatementRowsInput,
  // Unused: StatementRow has no `AuditEntityType` — see deleteStatementRows.
  _actor: ActorContext,
) {
  const { data, selector } = input;
  return withTransaction(db, async (tx) => {
    const values: Partial<typeof statementRow.$inferInsert> = {};
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
          .select({ id: statementRow.id })
          .from(statementRow)
          .where(
            and(
              eq(statementRow.source, selector.source),
              eq(statementRow.externalId, data.supersededByExternalId),
              notDeleted(statementRow),
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

    const updated = await unwrapDb(tx)
      .update(statementRow)
      .set(values)
      .where(selectorConditions(selector))
      .returning({ id: statementRow.id });
    return { affected: updated.length };
  });
}

/**
 * Soft-delete the selected rows. Rare by design: a row that will never match is
 * `ignored` with its reasoning, which keeps the evidence. Deletion is for rows
 * that should never have been recorded — a mis-parsed export.
 */
export async function deleteStatementRows(
  db: Database,
  selector: StatementRowSelector,
  // Unused: StatementRow isn't in entity-core.ts's `Entity` union, so
  // `logAuditEntry` has no `AuditEntityType` to name it under — nothing here
  // can produce a truthful audit entry. TODO: once StatementRow gets a
  // manifest entry, route this through `removeEntity` instead (also brings
  // cascade/locking, and `removeEntity` needs an id list, not a filter
  // selector — same promotion this selector shape is blocked on today).
  _actor: ActorContext,
) {
  return withTransaction(db, async (tx) => {
    const deleted = await unwrapDb(tx)
      .update(statementRow)
      .set({ deletedAt: new Date() })
      .where(selectorConditions(selector))
      .returning({ id: statementRow.id });
    return { affected: deleted.length };
  });
}

export async function listStatementImports(db: Database, source?: string) {
  const rows = await unwrapDb(db)
    .select({
      id: statementImport.id,
      source: statementImport.source,
      label: statementImport.label,
      fingerprint: statementImport.fingerprint,
      dateKind: statementImport.dateKind,
      rowCountDeclared: statementImport.rowCountDeclared,
      notes: statementImport.notes,
      createdAt: statementImport.createdAt,
      updatedAt: statementImport.updatedAt,
      rowCountStored: sql<number>`(
        SELECT count(*)::int FROM "StatementRow" sr
        WHERE sr."batchId" = "StatementImport"."id" AND sr."deletedAt" IS NULL
      )`,
    })
    .from(statementImport)
    .where(
      and(
        notDeleted(statementImport),
        source ? eq(statementImport.source, source) : undefined,
      ),
    )
    .orderBy(desc(statementImport.createdAt));
  return {
    data: rows.map((row) => statementImportOut.parse(row)),
    count: rows.length,
  };
}
