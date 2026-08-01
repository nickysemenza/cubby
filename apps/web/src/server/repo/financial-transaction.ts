import type { ActorContext } from "@cubby/schemas/context";
import type { ImpactItem } from "@cubby/schemas/entity-integrity";
import type {
  FinancialTransactionCreateInput,
  FinancialTransactionFilters,
  FinancialTransactionOut,
  FinancialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import {
  financialTransactionOut,
  financialTransactionSettlementViolation,
  financialTransactionSortableFields,
} from "@cubby/schemas/financial-transaction";
import {
  type FinancialTransactionId,
  type FinancialTransactionShortcode,
  type PurchaseId,
  unsafeFinancialAccountId,
  unsafeFinancialAccountShortcode,
  unsafeFinancialTransactionId,
  unsafeFinancialTransactionShortcode,
  unsafePurchaseId,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import { financialTransaction } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import { touchDataQualityTargets } from "~/server/repo/data-quality";
import {
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  countWhere,
  eqAny,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  lockAndValidateForDelete,
  matchesStringValues,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { lockFinancialEvidenceKeys } from "~/server/repo/financial-evidence";
import { relatedWhereConditions } from "~/server/repo/related-view";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
  resolveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

const accountName = sql<string | null>`(
  SELECT fa.name FROM "FinancialAccount" fa
  WHERE fa.id = "FinancialTransaction"."accountId" AND fa."deletedAt" IS NULL
)`;

const columns = {
  id: financialTransaction.id,
  shortcode: financialTransaction.shortcode,
  accountId: financialTransaction.accountId,
  purchaseId: financialTransaction.purchaseId,
  kind: financialTransaction.kind,
  status: financialTransaction.status,
  amount: financialTransaction.amount,
  transactionDate: financialTransaction.transactionDate,
  postedDate: financialTransaction.postedDate,
  merchant: financialTransaction.merchant,
  rawDescription: financialTransaction.rawDescription,
  sourceCategory: financialTransaction.sourceCategory,
  sourceRefs: financialTransaction.sourceRefs,
  notes: financialTransaction.notes,
  createdAt: financialTransaction.createdAt,
  updatedAt: financialTransaction.updatedAt,
  accountShortcode: sql<string>`(SELECT fa.shortcode FROM "FinancialAccount" fa WHERE fa.id = "FinancialTransaction"."accountId")`,
  purchaseShortcode: sql<
    string | null
  >`(SELECT p.shortcode FROM "Purchase" p WHERE p.id = "FinancialTransaction"."purchaseId")`,
  accountName,
} as const;

type FinancialTransactionRow = Omit<
  typeof financialTransaction.$inferSelect,
  "deletedAt"
> & {
  accountShortcode: string;
  purchaseShortcode: string | null;
  accountName: string | null;
};

const toOut = (row: FinancialTransactionRow): FinancialTransactionOut =>
  financialTransactionOut.parse({
    id: unsafeFinancialTransactionShortcode(row.shortcode),
    accountId: unsafeFinancialAccountShortcode(row.accountShortcode),
    purchaseId: row.purchaseShortcode
      ? unsafePurchaseShortcode(row.purchaseShortcode)
      : null,
    kind: row.kind,
    status: row.status,
    amount: Number(row.amount),
    transactionDate: row.transactionDate,
    postedDate: row.postedDate,
    merchant: row.merchant,
    rawDescription: row.rawDescription,
    sourceCategory: row.sourceCategory,
    sourceRefs: row.sourceRefs,
    notes: row.notes,
    accountName: row.accountName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

const refsCondition = (
  sources?: string[],
  externalIds?: string[],
): SQL | undefined => {
  if (!sources && !externalIds) return undefined;
  return sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof("FinancialTransaction"."sourceRefs") = 'array'
      THEN "FinancialTransaction"."sourceRefs" ELSE '[]'::jsonb END) ref
    WHERE ${matchesStringValues(sql`ref->>'source'`, sources)}
      AND ${matchesStringValues(sql`ref->>'externalId'`, externalIds)}
  )`;
};

async function toIds(
  db: Database,
  codes: string[] | undefined,
  entity: "financialAccount" | "purchase",
) {
  if (!codes) return undefined;
  const resolved = await resolveShortcodes(db, codes);
  return [...resolved.values()]
    .filter((ref) => ref.entity === entity)
    .map((ref) => ref.id);
}

async function whereFor(
  db: Database,
  filters: FinancialTransactionFilters,
): Promise<SQL | undefined> {
  const accountIds = await toIds(
    db,
    filters.accountId ? [filters.accountId].flat() : undefined,
    "financialAccount",
  );
  const purchaseIds = await toIds(
    db,
    filters.purchaseId ? [filters.purchaseId].flat() : undefined,
    "purchase",
  );
  // These filters name specific public ids. When supplied codes resolve to no
  // ids, the semantic result is an empty set; eqAny([], by design) means "no
  // constraint" and would otherwise expose the entire transaction roster.
  if (accountIds?.length === 0 || purchaseIds?.length === 0) return sql`false`;
  return buildSearchConditions(
    financialTransaction,
    [
      { column: financialTransaction.merchant, term: filters.search },
      { column: financialTransaction.rawDescription, term: filters.search },
    ],
    [
      ...relatedWhereConditions(
        "financialTransaction",
        filters,
        financialTransaction.id,
      ),
      eqAny(financialTransaction.accountId, accountIds),
      eqAny(financialTransaction.purchaseId, purchaseIds),
      filters.purchasePresenceFilter === "has"
        ? sql`${financialTransaction.purchaseId} IS NOT NULL`
        : filters.purchasePresenceFilter === "none"
          ? isNull(financialTransaction.purchaseId)
          : undefined,
      filters.kind
        ? sql`${financialTransaction.kind} = ANY(${[filters.kind].flat()})`
        : undefined,
      filters.status
        ? sql`${financialTransaction.status} = ANY(${[filters.status].flat()})`
        : undefined,
      refsCondition(
        filters.source ? [filters.source].flat() : undefined,
        filters.externalId ? [filters.externalId].flat() : undefined,
      ),
      filters.merchant
        ? formatSearchTerm(financialTransaction.merchant, filters.merchant)
        : undefined,
      filters.amountMin === undefined
        ? undefined
        : sql`${financialTransaction.amount} >= ${filters.amountMin}`,
      filters.amountMax === undefined
        ? undefined
        : sql`${financialTransaction.amount} <= ${filters.amountMax}`,
      filters.transactionDateFrom
        ? sql`${financialTransaction.transactionDate} >= ${filters.transactionDateFrom}`
        : undefined,
      filters.transactionDateTo
        ? sql`${financialTransaction.transactionDate} <= ${filters.transactionDateTo}`
        : undefined,
      filters.postedDateFrom
        ? sql`${financialTransaction.postedDate} >= ${filters.postedDateFrom}`
        : undefined,
      filters.postedDateTo
        ? sql`${financialTransaction.postedDate} <= ${filters.postedDateTo}`
        : undefined,
    ],
  );
}

export async function listFinancialTransactions(
  db: Database,
  filters: FinancialTransactionFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) {
  const where = await whereFor(db, filters);
  const { take, skip } = buildTakeSkip(pagination);
  const { data: rows, count } = await executeListQueryWithCount(
    getDb(db)
      .select(columns)
      .from(financialTransaction)
      .where(where)
      .orderBy(
        ...buildOrderBy(
          financialTransaction,
          sorts,
          [...financialTransactionSortableFields],
          {
            resolve: (sort) =>
              sort.orderBy === "merchant"
                ? [
                    (sort.direction === "asc" ? asc : desc)(
                      financialTransaction.merchant,
                    ),
                  ]
                : null,
          },
        ),
      )
      .limit(take)
      .offset(skip),
    countWhere(db, financialTransaction, where),
  );
  return {
    data: rows.map(toOut),
    count,
  };
}

const financialTransactionReader = createEntityReader<
  FinancialTransactionRow,
  FinancialTransactionOut,
  FinancialTransactionId,
  Database | DrizzleTransaction
>({
  entity: "financialTransaction",
  fetchById: async (db, id) => {
    const [row] = await unwrapDb(db)
      .select(columns)
      .from(financialTransaction)
      .where(
        and(eq(financialTransaction.id, id), notDeleted(financialTransaction)),
      )
      .limit(1);
    return row;
  },
  fromDB: (_db, row) => toOut(row),
  notFoundReason: "FINANCIAL_TRANSACTION_NOT_FOUND",
});

const getFinancialTransactionByID = financialTransactionReader.getByID;
export const getFinancialTransactionByShortcode =
  financialTransactionReader.getByShortcode;

async function assertSourceRefsAvailable(
  db: Database | DrizzleTransaction,
  refs: FinancialTransactionCreateInput["sourceRefs"],
  exceptId?: FinancialTransactionId,
) {
  for (const ref of refs) {
    const result = await unwrapDb(db).execute<{ id: string }>(sql`
      SELECT ft.id::text AS id FROM "FinancialTransaction" ft
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(ft."sourceRefs") = 'array' THEN ft."sourceRefs" ELSE '[]'::jsonb END) r
      WHERE ft."deletedAt" IS NULL
        AND r->>'source' = ${ref.source} AND r->>'externalId' = ${ref.externalId}
        ${exceptId ? sql`AND ft.id <> ${exceptId}` : sql``}
      LIMIT 1
    `);
    if (result.rows[0])
      throw createAppError(
        "FINANCIAL_TRANSACTION_SOURCE_REF_CONFLICT",
        `Source transaction ${ref.source}/${ref.externalId} is already recorded.`,
      );
  }
}

async function resolveForeignKeys(
  db: Database | DrizzleTransaction,
  data: Pick<FinancialTransactionCreateInput, "accountId" | "purchaseId">,
) {
  const accountUuid = await resolveLiveShortcode(
    db,
    data.accountId,
    "financialAccount",
  );
  if (!accountUuid)
    throw createAppError(
      "FINANCIAL_ACCOUNT_NOT_FOUND",
      `Financial account not found: ${data.accountId}`,
    );
  const purchaseUuid = data.purchaseId
    ? await resolveLiveShortcode(db, data.purchaseId, "purchase")
    : null;
  if (data.purchaseId && !purchaseUuid)
    throw createAppError(
      "PURCHASE_NOT_FOUND",
      `Purchase not found: ${data.purchaseId}`,
    );
  return {
    accountId: unsafeFinancialAccountId(accountUuid),
    purchaseId: purchaseUuid ? unsafePurchaseId(purchaseUuid) : null,
  };
}

export async function createFinancialTransaction(
  db: Database,
  data: FinancialTransactionCreateInput,
  actor: ActorContext,
) {
  const id = await withTransaction(db, async (tx) => {
    const foreign = await resolveForeignKeys(tx, data);
    await lockFinancialEvidenceKeys(
      tx,
      "transaction-ref",
      data.sourceRefs.map((ref) => `${ref.source}\0${ref.externalId}`),
    );
    await assertSourceRefsAvailable(tx, data.sourceRefs);
    const created = await insertWithShortcode(tx, "financialTransaction", {
      ...data,
      ...foreign,
    });
    await logAuditEntry(tx, actor, {
      entityType: "financialTransaction",
      entityId: created.id,
      action: "create",
    });
    if (foreign.purchaseId) {
      await touchDataQualityTargets(tx, { purchaseIds: [foreign.purchaseId] });
    }
    return created.id;
  });
  return { output: await getFinancialTransactionByID(db, id), entityId: id };
}

export async function updateFinancialTransaction(
  db: Database,
  shortcode: FinancialTransactionShortcode,
  data: FinancialTransactionUpdateData,
  actor: ActorContext,
) {
  const resolved = await resolveLiveShortcode(
    db,
    shortcode,
    "financialTransaction",
  );
  if (!resolved)
    throw createAppError(
      "FINANCIAL_TRANSACTION_NOT_FOUND",
      `Financial transaction not found: ${shortcode}`,
    );
  const id = unsafeFinancialTransactionId(resolved);
  await withTransaction(db, async (tx) => {
    const before = await tx.query.financialTransaction.findFirst({
      where: and(
        eq(financialTransaction.id, id),
        notDeleted(financialTransaction),
      ),
    });
    if (!before)
      throw createAppError(
        "FINANCIAL_TRANSACTION_NOT_FOUND",
        `Financial transaction not found: ${shortcode}`,
      );
    const accountId =
      data.accountId === undefined
        ? before.accountId
        : unsafeFinancialAccountId(
            (await resolveLiveShortcode(
              tx,
              data.accountId,
              "financialAccount",
            )) ??
              (() => {
                throw createAppError(
                  "FINANCIAL_ACCOUNT_NOT_FOUND",
                  `Financial account not found: ${data.accountId}`,
                );
              })(),
          );
    const purchaseId =
      data.purchaseId === undefined
        ? before.purchaseId
        : data.purchaseId === null
          ? null
          : unsafePurchaseId(
              (await resolveLiveShortcode(tx, data.purchaseId, "purchase")) ??
                (() => {
                  throw createAppError(
                    "PURCHASE_NOT_FOUND",
                    `Purchase not found: ${data.purchaseId}`,
                  );
                })(),
            );
    const sourceRefs = data.sourceRefs ?? before.sourceRefs;
    await lockFinancialEvidenceKeys(
      tx,
      "transaction-ref",
      sourceRefs.map((ref) => `${ref.source}\0${ref.externalId}`),
    );
    await assertSourceRefsAvailable(tx, sourceRefs, id);
    const values = buildPartialUpdateValues({ ...data, accountId, purchaseId });
    const nextStatus = data.status ?? before.status;
    const nextKind = data.kind ?? before.kind;
    const nextAmount = data.amount ?? before.amount;
    const nextPostedDate =
      data.postedDate === undefined ? before.postedDate : data.postedDate;
    if (nextStatus === "posted" && nextPostedDate === null)
      throw createAppError(
        "FINANCIAL_TRANSACTION_POSTED_DATE_REQUIRED",
        "Posted financial transactions require a posted date.",
      );
    const settlementViolation = financialTransactionSettlementViolation({
      purchaseId,
      kind: nextKind as FinancialTransactionCreateInput["kind"],
      amount: nextAmount,
    });
    if (settlementViolation)
      throw createAppError("CONSTRAINT_VIOLATION", settlementViolation.message);
    await tx
      .update(financialTransaction)
      .set(values)
      .where(
        and(eq(financialTransaction.id, id), notDeleted(financialTransaction)),
      );
    const changes = computeChanges(before, { ...before, ...values }, [
      "accountId",
      "purchaseId",
      "kind",
      "status",
      "amount",
      "transactionDate",
      "postedDate",
      "merchant",
      "rawDescription",
      "sourceCategory",
      "sourceRefs",
      "notes",
    ]);
    if (changes)
      await logAuditEntry(tx, actor, {
        entityType: "financialTransaction",
        entityId: id,
        action: "update",
        changes,
      });
    if (changes) {
      await touchDataQualityTargets(tx, {
        purchaseIds: [before.purchaseId, purchaseId].filter(
          (value): value is PurchaseId => value !== null,
        ),
      });
    }
  });
  return { output: await getFinancialTransactionByID(db, id), entityId: id };
}

export async function deleteFinancialTransactions(
  db: Database,
  shortcodes: FinancialTransactionShortcode[],
  actor: ActorContext,
) {
  const resolved = await resolveLiveShortcodes(
    db,
    shortcodes,
    "financialTransaction",
  );
  const ids = uniq(
    shortcodes.map((code) => {
      const id = resolved.get(code);
      if (!id)
        throw createAppError(
          "FINANCIAL_TRANSACTION_NOT_FOUND",
          `Financial transaction not found: ${code}`,
        );
      return unsafeFinancialTransactionId(id);
    }),
  );
  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(
      tx,
      financialTransaction,
      ids,
      "FinancialTransaction",
    );
    const qualityTargets = await tx.query.financialTransaction.findMany({
      where: and(
        inArray(financialTransaction.id, ids),
        notDeleted(financialTransaction),
      ),
      columns: { purchaseId: true },
    });
    await tx
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(
        and(
          inArray(financialTransaction.id, ids),
          notDeleted(financialTransaction),
        ),
      );
    await logAuditEntries(
      tx,
      actor,
      ids.map((entityId) => ({
        entityType: "financialTransaction" as const,
        entityId,
        action: "delete" as const,
      })),
    );
    await touchDataQualityTargets(tx, {
      purchaseIds: qualityTargets
        .map((row) => row.purchaseId)
        .filter((value): value is PurchaseId => value !== null),
    });
  });
}

/** Financial transactions have no incoming edges or delete side effects. */
export async function previewDeleteFinancialTransactions(
  _db: Database,
  _ids: FinancialTransactionId[],
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> {
  return { blockers: [], changes: [], sideEffects: [] };
}
