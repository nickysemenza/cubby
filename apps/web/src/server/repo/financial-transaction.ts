import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import type {
  FinancialTransactionCreateInput,
  FinancialTransactionFilters,
  FinancialTransactionOut,
  FinancialTransactionSourceOptionsOut,
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
  unsafeFinancialAccountShortcode,
  unsafeFinancialTransactionShortcode,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { touchDataQualityTargets } from "~/server/repo/data-quality";
import {
  auditDateWhereConditions,
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
import {
  type AllocationInput,
  applyAllocationChanges,
  assertAllocationSetValid,
  assertPurchasesLive,
  countLiveAllocations,
  readAllocations,
  resolveAllocationInputs,
  writeAllocationSet,
} from "~/server/repo/financial-transaction-allocations";
import { countByTarget, impact, present } from "~/server/repo/impact";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

/** Money comparisons go through cents; `===` on doubles reports phantom drift. */
const cents = (value: number) => Math.round(value * 100);

/** "This transaction settles at least one Purchase" — allocation-aware. */
const hasAnyAllocation = () => sql`EXISTS (
  SELECT 1 FROM "FinancialTransactionAllocation" fta
  WHERE fta."transactionId" = "FinancialTransaction"."id"
    AND fta."deletedAt" IS NULL
)`;

/**
 * "This transaction settles any of these Purchases" — allocation-aware.
 *
 * `IN (…)` over a joined list of bound parameters rather than `= ANY(array)`:
 * drizzle turns an interpolated JS array into a row constructor, which postgres
 * rejects outright.
 */
const allocatedToAny = (purchaseIds: readonly string[]) => sql`EXISTS (
  SELECT 1 FROM "FinancialTransactionAllocation" fta
  WHERE fta."transactionId" = "FinancialTransaction"."id"
    AND fta."deletedAt" IS NULL
    AND fta."purchaseId" IN (${sql.join(
      purchaseIds.map((id) => sql`${id}`),
      sql`, `,
    )})
)`;

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

// These are filters built from user-supplied codes, not a write target: a
// mixed batch (some valid, some bogus) should narrow to what exists rather
// than 404 the whole list, matching the same-shaped filters in
// locationList/productList. `resolveAllPresent` is the helper that makes
// that choice explicit instead of leaving it implicit in a hand-rolled
// resolve-then-filter.
async function toIds(
  db: Database,
  codes: string[] | undefined,
  entity: "financialAccount" | "purchase",
) {
  if (!codes) return undefined;
  return resolveAllPresent(db, entity, codes);
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
      ...auditDateWhereConditions(financialTransaction, filters),
      ...relatedWhereConditions(
        "financialTransaction",
        filters,
        financialTransaction.id,
      ),
      eqAny(financialTransaction.accountId, accountIds),
      // Allocations, not the mirror column: a transaction split across two
      // purchases has a NULL mirror, so filtering on it would hide the split
      // row from BOTH purchases — including the linked-transactions table on
      // each purchase's detail page, which is exactly where it must appear.
      purchaseIds ? allocatedToAny(purchaseIds) : undefined,
      filters.purchasePresenceFilter === "has"
        ? hasAnyAllocation()
        : filters.purchasePresenceFilter === "none"
          ? sql`NOT ${hasAnyAllocation()}`
          : undefined,
      // `eqAny`, NOT sql`col = ANY(${arr})`: drizzle expands a JS array in a
      // template into a row constructor (`ANY(($1, $2))`), which postgres
      // rejects — `ANY` wants an array, so the whole query 500s.
      eqAny(financialTransaction.kind, filters.kind),
      eqAny(financialTransaction.status, filters.status),
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
  const accountId = await resolveOrThrow(
    db,
    "financialAccount",
    data.accountId,
  );
  const purchaseId = data.purchaseId
    ? await resolveOrThrow(db, "purchase", data.purchaseId)
    : null;
  return { accountId, purchaseId };
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
    const { allocations, ...columns } = data;
    const created = await insertWithShortcode(tx, "financialTransaction", {
      ...columns,
      ...foreign,
    });
    await logAuditEntry(tx, actor, {
      entityType: "financialTransaction",
      entityId: created.id,
      action: "create",
    });

    // `purchaseId` is sugar for one allocation of the full amount; the zod
    // refinement has already rejected a purchaseId/allocations pair that
    // disagrees, so either source can be taken verbatim here.
    const requested: AllocationInput[] =
      allocations.length > 0
        ? await resolveAllocationInputs(tx, allocations)
        : foreign.purchaseId
          ? [{ purchaseId: foreign.purchaseId, amount: data.amount }]
          : [];
    if (requested.length > 0) {
      await assertPurchasesLive(
        tx,
        requested.map((row) => row.purchaseId),
      );
      assertAllocationSetValid({
        transactionAmount: data.amount,
        kind: data.kind,
        next: requested,
      });
      await writeAllocationSet(tx, created.id, requested, new Map());
      await applyAllocationChanges(tx, {
        transactionIds: [created.id],
        before: new Map(),
        actor,
      });
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
  const id = await resolveOrThrow(db, "financialTransaction", shortcode);
  await withTransaction(db, async (tx) => {
    // Lock before reading: the amount and its allocations must move together,
    // and this is the same row lock setFinancialTransactionAllocations takes,
    // so the two cannot interleave.
    await tx
      .select({ id: financialTransaction.id })
      .from(financialTransaction)
      .where(
        and(eq(financialTransaction.id, id), notDeleted(financialTransaction)),
      )
      .for("update");
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
        : await resolveOrThrow(tx, "financialAccount", data.accountId);
    const purchaseId =
      data.purchaseId === undefined
        ? before.purchaseId
        : data.purchaseId === null
          ? null
          : await resolveOrThrow(tx, "purchase", data.purchaseId);
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
    const allocationCount = await countLiveAllocations(tx, id);
    const settlementViolation = financialTransactionSettlementViolation({
      // A split transaction's mirror is NULL while it is very much linked, so
      // linkage is the allocation count first and the mirror only as a fallback
      // for rows this migration has not reached.
      linked: allocationCount > 0 || purchaseId !== null,
      kind: nextKind as FinancialTransactionCreateInput["kind"],
      amount: nextAmount,
    });
    if (settlementViolation)
      throw createAppError("CONSTRAINT_VIOLATION", settlementViolation.message);

    // The amount and its allocations must stay in agreement. With one allocation
    // the invariant admits exactly one legal value, so writing it is forced
    // rather than fabricated — that keeps the ordinary "fix the amount typo"
    // flow working. With two or more there is no defensible way to redistribute
    // the difference: proportional rescaling would silently rewrite an evidence
    // split, which is precisely the fabrication this table exists to end.
    const amountChanged = cents(nextAmount) !== cents(before.amount);
    if (amountChanged && allocationCount >= 2)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `This transaction's amount is split across ${allocationCount} purchases. Re-allocate it first, then the amount will follow.`,
      );
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

    // Keep the allocations in step with what just changed, then let the shared
    // core own the follow-ups. This is the only door for setting a split — there
    // is deliberately no separate allocations endpoint, because `allocations` is
    // already part of this input and a second entry point would be a second
    // place to forget the lock and the invariant. Three triggers, in precedence
    // order:
    //   • an explicit `allocations` array — the general case;
    //   • an explicit `purchaseId` — the single-Purchase sugar, meaning "one
    //     slice for the whole amount", or clear it;
    //   • an amount change on a singly-allocated transaction, where the sole
    //     legal allocation value is the new amount.
    const allocationsBefore = await readAllocations(tx, [id]);
    const explicitPurchaseChange =
      data.purchaseId !== undefined && purchaseId !== before.purchaseId;
    let nextAllocations: AllocationInput[] | null = null;
    if (data.allocations !== undefined) {
      nextAllocations = await resolveAllocationInputs(tx, data.allocations);
    } else if (explicitPurchaseChange) {
      nextAllocations = purchaseId ? [{ purchaseId, amount: nextAmount }] : [];
    } else if (amountChanged && allocationCount === 1) {
      const sole = allocationsBefore.get(id)?.[0];
      if (sole)
        nextAllocations = [{ purchaseId: sole.purchaseId, amount: nextAmount }];
    }
    if (nextAllocations !== null) {
      await assertPurchasesLive(
        tx,
        nextAllocations.map((row) => row.purchaseId),
      );
      assertAllocationSetValid({
        transactionAmount: nextAmount,
        kind: nextKind,
        next: nextAllocations,
      });
      await writeAllocationSet(tx, id, nextAllocations, allocationsBefore);
    }
    await applyAllocationChanges(tx, {
      transactionIds: [id],
      before: allocationsBefore,
      actor,
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

export const FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY = {
  "FinancialTransactionAllocation.transactionId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Deleting a settlement transaction soft-deletes the purchase allocations that decompose it. Those Purchases keep their expenses and their identity; they simply lose this piece of settlement evidence.",
  },
} as const satisfies IncomingEdgePolicy<
  "financialTransaction",
  OperationDisposition
>;

export async function deleteFinancialTransactions(
  db: Database,
  shortcodes: FinancialTransactionShortcode[],
  actor: ActorContext,
) {
  const ids = uniq(
    await resolveAllOrThrow(db, "financialTransaction", shortcodes),
  );
  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(
      tx,
      financialTransaction,
      ids,
      "FinancialTransaction",
    );
    // Quality targets come from the allocations as well as the mirror: a
    // transaction split across two purchases has a NULL mirror, so reading only
    // that column would leave both purchases' data-quality exceptions stale.
    const [mirrorTargets, allocationTargets] = await Promise.all([
      tx.query.financialTransaction.findMany({
        where: and(
          inArray(financialTransaction.id, ids),
          notDeleted(financialTransaction),
        ),
        columns: { purchaseId: true },
      }),
      tx.query.financialTransactionAllocation.findMany({
        where: and(
          inArray(financialTransactionAllocation.transactionId, ids),
          notDeleted(financialTransactionAllocation),
        ),
        columns: { purchaseId: true },
      }),
    ]);
    await removeEntity(tx, {
      entity: "financialTransaction",
      ids,
      removal: "soft",
      actor,
      children: [
        {
          table: financialTransactionAllocation,
          parentColumns: [financialTransactionAllocation.transactionId],
          auditKey: "cascadedSettlementAllocations",
        },
      ],
    });
    await touchDataQualityTargets(tx, {
      purchaseIds: uniq([
        ...mirrorTargets
          .map((row) => row.purchaseId)
          .filter((value): value is PurchaseId => value !== null),
        ...allocationTargets.map((row) => row.purchaseId),
      ]),
    });
  });
}

/**
 * Nothing refuses a transaction delete — its allocations are parts of it, not
 * dependents with a claim on it — but they do go with it, so the preview says so.
 */
export async function previewDeleteFinancialTransactions(
  db: Database,
  ids: FinancialTransactionId[],
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> {
  const dbClient = getDb(db);
  return {
    blockers: [],
    changes: present([
      impact({
        disposition:
          FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY[
            "FinancialTransactionAllocation.transactionId"
          ],
        edgeKey: "FinancialTransactionAllocation.transactionId",
        label: "settlement allocations removed",
        byTargetId: await countByTarget(
          dbClient,
          financialTransactionAllocation,
          financialTransactionAllocation.transactionId,
          ids,
        ),
      }),
    ]),
    sideEffects: [],
  };
}

/**
 * Distinct `sourceRefs[].source` values across live transactions, with counts.
 *
 * `sourceRefs` is a jsonb array, so this unnests rather than grouping a column —
 * one transaction carrying both a `monarch` and a `zoro` ref counts once under
 * each, which is what a filter over "has a ref from this source" means.
 */
export async function financialTransactionSourceOptions(
  db: Database,
): Promise<FinancialTransactionSourceOptionsOut> {
  const rows = await getDb(db).execute<{ source: string; count: number }>(sql`
    SELECT ref->>'source' AS source, count(*)::int AS count
    FROM "FinancialTransaction" ft
    CROSS JOIN LATERAL jsonb_array_elements(ft."sourceRefs") ref
    WHERE ft."deletedAt" IS NULL AND ref->>'source' IS NOT NULL
    GROUP BY 1
    ORDER BY count(*) DESC, 1 ASC
  `);
  return rows.rows.map((row) => ({
    source: row.source,
    count: Number(row.count),
  }));
}
