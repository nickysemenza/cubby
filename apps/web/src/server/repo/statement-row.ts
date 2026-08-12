import type { ActorContext } from "@cubby/schemas/context";
import {
  unsafeFinancialAccountShortcode,
  unsafeFinancialTransactionShortcode,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { buildTakeSkip } from "@cubby/schemas/pagination";
import type {
  RecordStatementRowsInput,
  StatementRowFilters,
  StatementRowOut,
  StatementRowSelector,
  UpdateStatementRowsInput,
} from "@cubby/schemas/statement-row";
import {
  statementImportOut,
  statementRowOut,
} from "@cubby/schemas/statement-row";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
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
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
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

/**
 * The table plus its match evidence. Every read goes through this so the join —
 * and therefore the meaning of `matchState` — cannot differ between the list,
 * the count and the summary.
 */
const FROM_WITH_REFS = sql`FROM "StatementRow"
  LEFT JOIN ${LIVE_REFS} lr
    ON lr.source = "StatementRow"."source"
   AND lr."externalId" = "StatementRow"."externalId"`;

const matchedTransaction = sql<string | null>`lr.shortcode`;

/**
 * Four states, computed in SQL so filtering and pagination stay server-side.
 * Order matters: an ignored row is ignored whether or not it matched, and a
 * superseded row is off the worklist regardless of its own match state.
 */
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

type StatementRowRow = {
  [K in keyof typeof columns]: unknown;
};

/**
 * The reads run as raw SQL, so values arrive as the pg driver types them rather
 * than as drizzle's column modes: timestamps and `date` columns come back as
 * Date objects, numerics as strings. Coerce here so the output contract is the
 * same whichever way a row was fetched.
 */
const asDate = (value: unknown): Date =>
  value instanceof Date ? value : new Date(String(value));

/** pg builds a `date` at LOCAL midnight, so read the local parts back out. */
const asPlainDate = (value: unknown): string => {
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
      ? unsafeFinancialAccountShortcode(String(row.accountShortcode))
      : null,
    transactionId: row.transactionShortcode
      ? unsafeFinancialTransactionShortcode(String(row.transactionShortcode))
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
  if (filters.amountMin !== undefined)
    conditions.push(sql`${statementRow.amount} >= ${filters.amountMin}`);
  if (filters.amountMax !== undefined)
    conditions.push(sql`${statementRow.amount} <= ${filters.amountMax}`);
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
  return {
    data: data.rows.map((row) => toOut(row)),
    count: Number(counted.rows[0]?.count ?? 0),
  };
}

/**
 * Header summary for the active filter, in one pass.
 *
 * `matchState` is computed once per row in a subselect and the aggregates read
 * that column, rather than each FILTER re-deriving it. With the old correlated
 * probe that repetition was the difference between one scan and six.
 */
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
 * Idempotent — re-submitting an export inserts nothing.
 */
export async function recordStatementRows(
  db: Database,
  input: RecordStatementRowsInput,
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
      inserted: inserted.length,
      unchanged: rows.length - inserted.length,
      rowCountStored: before + inserted.length,
    };
  });
}

/**
 * Resolve a selector to the SQL that addresses its rows.
 *
 * Both shapes route through `buildConditions`, so a filtered bulk write
 * addresses exactly the rows the same filter would have listed — there is no
 * second, subtly different notion of "which rows" to drift out of sync.
 */
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

/**
 * Write agent judgments onto the selected rows. Accepts only judgment fields —
 * provider evidence is immutable after ingest, enforced by the input schema's
 * shape rather than by convention.
 */
export async function updateStatementRows(
  db: Database,
  input: UpdateStatementRowsInput,
  _actor: ActorContext,
) {
  const { data, selector } = input;
  return withTransaction(db, async (tx) => {
    const values: Record<string, unknown> = {};
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

/** The recorded exports, newest first, with what actually landed for each. */
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
