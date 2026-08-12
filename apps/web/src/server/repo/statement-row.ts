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
  countWhere,
  executeListQueryWithCount,
  formatSearchTerm,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { statementRowExternalId } from "~/server/repo/statement-row-identity";

/**
 * Whether a live transaction claims this row's `(source, externalId)` pair.
 *
 * LOAD-BEARING DEPENDENCY, and it lives in another file: this is a plain
 * correlated lookup with no DISTINCT because `assertSourceRefsAvailable`
 * (repo/financial-transaction.ts) guarantees the pair is globally unique across
 * live transactions. Weakening that guarantee makes this fan out silently.
 *
 * Cost scales with FinancialTransaction (~3.4k refs), not with StatementRow, and
 * the containment probe is served by FinancialTransaction_sourceRefs_gin_idx.
 */
const matchedTransaction = sql<string | null>`(
  SELECT ft.shortcode FROM "FinancialTransaction" ft
  WHERE ft."deletedAt" IS NULL
    AND ft."sourceRefs" @> jsonb_build_array(
      jsonb_build_object(
        'source', "StatementRow"."source",
        'externalId', "StatementRow"."externalId"
      )
    )
  LIMIT 1
)`;

/**
 * Four states, computed in SQL so filtering and pagination stay server-side.
 * Order matters: an ignored row is ignored whether or not it matched, and a
 * superseded row is off the worklist regardless of its own match state.
 */
const matchStateSql = sql<string>`CASE
  WHEN ${statementRow.disposition} = 'ignored' THEN 'ignored'
  WHEN ${statementRow.supersededByRowId} IS NOT NULL THEN 'superseded'
  WHEN ${matchedTransaction} IS NOT NULL THEN 'matched'
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

const toOut = (row: StatementRowRow): StatementRowOut =>
  statementRowOut.parse({
    ...row,
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

  const { data, count } = await executeListQueryWithCount(
    unwrapDb(db)
      .select(columns)
      .from(statementRow)
      .where(where)
      // Tie-broken by id: statementDate alone is not unique, and an unstable
      // sort silently repeats or skips rows across pages.
      .orderBy(direction(orderColumn), asc(statementRow.id))
      .limit(take)
      .offset(skip),
    countWhere(db, statementRow, where),
  );
  return { data: data.map((row) => toOut(row)), count };
}

/** Header summary for the active filter, computed in one pass. */
export async function getStatementRowSummary(
  db: Database,
  filters: StatementRowFilters,
) {
  const where = and(...buildConditions(filters))!;
  const [row] = await unwrapDb(db)
    .select({
      total: sql<number>`count(*)::int`,
      matched: sql<number>`count(*) FILTER (WHERE ${matchStateSql} = 'matched')::int`,
      unmatched: sql<number>`count(*) FILTER (WHERE ${matchStateSql} = 'unmatched')::int`,
      ignored: sql<number>`count(*) FILTER (WHERE ${matchStateSql} = 'ignored')::int`,
      superseded: sql<number>`count(*) FILTER (WHERE ${matchStateSql} = 'superseded')::int`,
      amountTotal: sql<number>`COALESCE(sum(${statementRow.amount}), 0)`,
      unmatchedAmount: sql<number>`COALESCE(sum(${statementRow.amount}) FILTER (WHERE ${matchStateSql} = 'unmatched'), 0)`,
    })
    .from(statementRow)
    .where(where);
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
  return and(...buildConditions(selector.filter))!;
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
