import type { ActorContext } from "@cubby/schemas/context";
import type { DataQuality } from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type {
  FinancialTransactionCreateInput,
  FinancialTransactionFilters,
  FinancialTransactionOut,
  FinancialTransactionSourceOptionsOut,
  FinancialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import {
  financialTransactionKind,
  financialTransactionOut,
  financialTransactionSettlementViolation,
} from "@cubby/schemas/financial-transaction";
import {
  type FinancialTransactionId,
  type FinancialTransactionShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, asc, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { capitalize, uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { entityRepository } from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  loadDataQualities,
  touchDataQualityTargets,
} from "~/server/repo/data-quality";
import {
  buildPartialUpdateValues,
  eqAny,
  getDb,
  type ListReadIntent,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { allocationIntegrityDefectSql } from "~/server/repo/financial-allocation-integrity";
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
import { listScaffold } from "~/server/repo/list-scaffold";
import { enrichFinancialTransactionsWithVendorInference } from "~/server/repo/merchant-vendor-inference";
import { cents } from "~/server/repo/money";
import { relatedWhereConditions } from "~/server/repo/related-view";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

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
  ledgerTransferShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "LedgerTransfer" WHERE id = "FinancialTransaction"."ledgerTransferId")`,
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
  // Ordered by shortcode so the field is stable across reads rather than
  // following whatever order the planner happens to produce.
  allocations: sql<{ purchaseId: string; amount: number }[]>`COALESCE((
    SELECT jsonb_agg(jsonb_build_object('purchaseId', ap.shortcode, 'amount', aa."amount") ORDER BY ap.shortcode)
    FROM "FinancialTransactionAllocation" aa
    JOIN "Purchase" ap ON ap."id" = aa."purchaseId"
    WHERE aa."transactionId" = "FinancialTransaction"."id" AND aa."deletedAt" IS NULL
  ), '[]'::jsonb)`,
  accountName,
} as const;

const selectTransactions = (db: Database | DrizzleTransaction) =>
  unwrapDb(db).select(columns).from(financialTransaction);
type FinancialTransactionRow = Awaited<
  ReturnType<typeof selectTransactions>
>[number];

const hydrate = async (
  db: Database | DrizzleTransaction,
  rows: FinancialTransactionRow[],
): Promise<FinancialTransactionOut[]> => {
  const dataQualities = await loadDataQualities(
    db,
    "financialTransaction",
    rows.map((row) => row.id),
  );
  return enrichFinancialTransactionsWithVendorInference(
    db,
    // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
    rows.map((row) => toOut(row, dataQualities.get(row.id)!)),
  );
};

const toOut = (
  row: FinancialTransactionRow,
  dataQuality: DataQuality,
): FinancialTransactionOut => {
  const allocations = (row.allocations ?? []).map((allocation) => ({
    purchaseId: parseShortcodeFor("purchase", allocation.purchaseId),
    amount: Number(allocation.amount),
  }));
  return financialTransactionOut.parse({
    id: parseShortcodeFor("financialTransaction", row.shortcode),
    accountId: parseShortcodeFor("financialAccount", row.accountShortcode),
    // DERIVED, not stored: the sole Purchase this transaction settled, or null
    // when it settled none or several. Kept in the output because 3,445 of
    // 3,447 transactions have exactly one allocation and every consumer of that
    // shape reads better for it.
    purchaseId:
      allocations.length === 1 && allocations[0]
        ? allocations[0].purchaseId
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
    allocations,
    ledgerTransferId: row.ledgerTransferShortcode
      ? parseShortcodeFor("ledgerTransfer", row.ledgerTransferShortcode)
      : null,
    accountName: row.accountName,
    // `merchant`/`rawDescription` are both nullable statement fields; `kind`
    // is the last resort so an imported row with neither still gets a
    // non-blank identity.
    displayName:
      row.merchant?.trim() ||
      row.rawDescription?.trim() ||
      capitalize(row.kind.replaceAll("_", " ")),
    dataQuality,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

/**
 * Containment (`@>`), not a `jsonb_array_elements` subquery, so the GIN index on
 * sourceRefs serves the filter instead of a sequential scan.
 *
 * Supplying both lists yields their cross product, because "source and
 * externalId on the *same* ref" is what one containment operand expresses —
 * OR-ing two independent groups would match a transaction that took its source
 * from one ref and its externalId from another. Both lists come from UI filter
 * state, so the product stays small.
 *
 * The `jsonb_typeof` guard the subquery needed is gone: `@>` against a scalar or
 * non-array jsonb returns false rather than erroring.
 *
 * Emptiness is normalized on `.length`, NOT nullishness: `oneOrMany`'s array
 * branch has no `.min(1)`, so `[]` is valid input and is not nullish. Letting it
 * through collapses the cross-product to zero operands, which makes `or()`
 * return undefined and silently drops the *other* field's constraint — turning
 * "externalId = X" into a whole-table match. An empty list means "no constraint
 * on that field", never "no constraint at all".
 */
interface SourceReferenceOperand {
  source?: string;
  externalId?: string;
}

const refsCondition = (
  sources?: string[],
  externalIds?: string[],
): SQL | undefined => {
  const src = sources?.length ? sources : undefined;
  const ext = externalIds?.length ? externalIds : undefined;
  if (!src && !ext) return undefined;
  const operands = (src ?? [undefined]).flatMap((source) =>
    (ext ?? [undefined]).map((externalId) => {
      const reference: SourceReferenceOperand = {};
      if (source !== undefined) reference.source = source;
      if (externalId !== undefined) reference.externalId = externalId;
      return JSON.stringify([reference]);
    }),
  );
  return or(
    ...operands.map(
      (operand) => sql`${financialTransaction.sourceRefs} @> ${operand}::jsonb`,
    ),
  );
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

const financialTransactionScaffold = listScaffold(
  "financialTransaction",
  financialTransaction,
);

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export async function buildFinancialTransactionWhere(
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
  // `kind`, `status`, `merchant`, and `postedDate` are declared stored
  // filters — applied by `financialTransactionScaffold.where` before the
  // conditions below.
  return financialTransactionScaffold.where(filters, [
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
    filters.allocationIntegrity === "defect"
      ? allocationIntegrityDefectSql('"FinancialTransaction"')
      : undefined,
    refsCondition(
      filters.source ? [filters.source].flat() : undefined,
      filters.externalId ? [filters.externalId].flat() : undefined,
    ),
  ]);
}

export const listFinancialTransactions = async (
  db: Database,
  filters: FinancialTransactionFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
) =>
  financialTransactionScaffold.list(
    db,
    { filters, sorts, pagination, readIntent },
    {
      where: await buildFinancialTransactionWhere(db, filters),
      resolveSort: (sort) =>
        sort.orderBy === "merchant"
          ? [
              (sort.direction === "asc" ? asc : desc)(
                financialTransaction.merchant,
              ),
            ]
          : null,
      select: (page) =>
        selectTransactions(db)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      hydrate: (rows) => hydrate(db, rows),
    },
  );

const financialTransactionReader = createEntityReader<
  FinancialTransactionRow,
  FinancialTransactionOut,
  "financialTransaction",
  Database | DrizzleTransaction
>({
  entity: "financialTransaction",
  fetchById: async (db, id) => {
    const [row] = await selectTransactions(db)
      .where(
        and(eq(financialTransaction.id, id), notDeleted(financialTransaction)),
      )
      .limit(1);
    return row;
  },
  fromDB: async (db, row) => (await hydrate(db, [row]))[0]!,
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
    // Containment (`@>`) rather than unnesting every row's refs: this is the
    // global uniqueness guarantee that lets readers join on
    // (source, externalId) without a DISTINCT, and it ran as a sequential scan
    // on every write. `@>` against a scalar or non-array jsonb returns false
    // instead of erroring, so the old `jsonb_typeof` guard is unnecessary.
    const operand = JSON.stringify([
      { source: ref.source, externalId: ref.externalId },
    ]);
    const result = await unwrapDb(db).execute<{ id: string }>(sql`
      SELECT ft.id::text AS id FROM "FinancialTransaction" ft
      WHERE ft."deletedAt" IS NULL
        AND ft."sourceRefs" @> ${operand}::jsonb
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
  return { accountId };
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
        : data.purchaseId
          ? await resolveAllocationInputs(tx, [
              { purchaseId: data.purchaseId, amount: data.amount },
            ])
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

type FinancialTransactionDbRow = typeof financialTransaction.$inferSelect;

const lockUpdatePurchases = async (
  tx: DrizzleTransaction,
  id: FinancialTransactionId,
  data: FinancialTransactionUpdateData,
) => {
  const incomingCodes = [
    ...(data.allocations?.map((row) => row.purchaseId) ?? []),
    ...(data.purchaseId ? [data.purchaseId] : []),
  ];
  const current = (await readAllocations(tx, [id])).get(id) ?? [];
  const incoming =
    incomingCodes.length > 0
      ? await resolveAllOrThrow(tx, "purchase", incomingCodes)
      : [];
  await assertPurchasesLive(
    tx,
    uniq([...current.map((row) => row.purchaseId), ...incoming]),
  );
};

const assertLedgerTransferUpdateAllowed = (
  before: FinancialTransactionDbRow,
  data: FinancialTransactionUpdateData,
) => {
  if (before.ledgerTransferId === null) return;
  const changesEvidence =
    data.accountId !== undefined ||
    data.status !== undefined ||
    data.amount !== undefined ||
    data.allocations !== undefined ||
    data.purchaseId !== undefined;
  if (changesEvidence) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A financial transaction linked as ledger-transfer evidence cannot be changed in a way that could invalidate that evidence. Update the transfer evidence set first.",
    );
  }
};

const assertAllocationShorthandAgrees = (
  data: FinancialTransactionUpdateData,
) => {
  if (data.purchaseId === undefined || data.allocations === undefined) return;
  const single = data.allocations.length === 1 ? data.allocations[0] : null;
  const agrees =
    data.purchaseId === null
      ? data.allocations.length === 0
      : single?.purchaseId === data.purchaseId;
  if (!agrees) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "purchaseId and allocations disagree. purchaseId is shorthand for one allocation of the full amount — supply one or the other.",
    );
  }
};

const deriveUpdatedTransactionState = async (
  tx: DrizzleTransaction,
  id: FinancialTransactionId,
  before: FinancialTransactionDbRow,
  data: FinancialTransactionUpdateData,
) => {
  const nextStatus = data.status ?? before.status;
  const nextKind = data.kind ?? before.kind;
  const nextAmount = data.amount ?? before.amount;
  const nextPostedDate =
    data.postedDate === undefined ? before.postedDate : data.postedDate;
  if (nextStatus === "posted" && nextPostedDate === null) {
    throw createAppError(
      "FINANCIAL_TRANSACTION_POSTED_DATE_REQUIRED",
      "Posted financial transactions require a posted date.",
    );
  }
  const allocationCount = await countLiveAllocations(tx, id);
  const linked =
    data.allocations !== undefined
      ? data.allocations.length > 0
      : data.purchaseId !== undefined
        ? data.purchaseId !== null
        : allocationCount > 0;
  const settlementViolation = financialTransactionSettlementViolation({
    linked,
    kind: financialTransactionKind.parse(nextKind),
    amount: nextAmount,
  });
  if (settlementViolation) {
    throw createAppError("CONSTRAINT_VIOLATION", settlementViolation.message);
  }
  const amountChanged = cents(nextAmount) !== cents(before.amount);
  if (amountChanged && allocationCount >= 2) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `This transaction's amount is split across ${allocationCount} purchases. Re-allocate it first, then the amount will follow.`,
    );
  }
  return { nextKind, nextAmount, allocationCount, amountChanged };
};

const requestedUpdateAllocations = async (
  tx: DrizzleTransaction,
  id: FinancialTransactionId,
  data: FinancialTransactionUpdateData,
  state: Awaited<ReturnType<typeof deriveUpdatedTransactionState>>,
  before: Awaited<ReturnType<typeof readAllocations>>,
): Promise<AllocationInput[] | null> => {
  if (data.allocations !== undefined) {
    return resolveAllocationInputs(tx, data.allocations);
  }
  if (data.purchaseId !== undefined) {
    return data.purchaseId
      ? resolveAllocationInputs(tx, [
          { purchaseId: data.purchaseId, amount: state.nextAmount },
        ])
      : [];
  }
  if (!state.amountChanged || state.allocationCount !== 1) return null;
  const sole = before.get(id)?.[0];
  return sole
    ? [{ purchaseId: sole.purchaseId, amount: state.nextAmount }]
    : null;
};

const applyUpdatedAllocations = async (
  tx: DrizzleTransaction,
  id: FinancialTransactionId,
  data: FinancialTransactionUpdateData,
  state: Awaited<ReturnType<typeof deriveUpdatedTransactionState>>,
  actor: ActorContext,
) => {
  const before = await readAllocations(tx, [id]);
  const next = await requestedUpdateAllocations(tx, id, data, state, before);
  if (next !== null) {
    await assertPurchasesLive(
      tx,
      next.map((row) => row.purchaseId),
    );
    assertAllocationSetValid({
      transactionAmount: state.nextAmount,
      kind: financialTransactionKind.parse(state.nextKind),
      next,
    });
    await writeAllocationSet(tx, id, next, before);
  }
  await applyAllocationChanges(tx, { transactionIds: [id], before, actor });
};

export async function updateFinancialTransaction(
  db: Database,
  shortcode: FinancialTransactionShortcode,
  data: FinancialTransactionUpdateData,
  actor: ActorContext,
) {
  const id = await resolveOrThrow(db, "financialTransaction", shortcode);
  await withTransaction(db, async (tx) => {
    // Funding-evidence advisory keys precede both entity rows and account keys.
    // Evidence creation uses the same order, so it cannot validate an old row
    // while this mutation commits a new amount/status/account.
    // LOCK ORDER: Purchase rows first, THEN the transaction row. Every purchase
    // operation locks purchases first (lockAndValidateForDelete, the merge) and
    // reaches FinancialTransaction afterwards via syncSettlementMirror, so
    // taking the transaction first here would form an ABBA cycle — updating a
    // transaction while one of its purchases is being deleted would deadlock and
    // postgres would abort one of them. Keep this order.
    //
    // The set locked here must cover every purchase this update could touch —
    // the ones it already allocates to AND the ones it is about to. Locking only
    // the current ones would leave a newly named purchase to be locked after the
    // transaction, reopening the cycle for exactly the interesting case.
    //
    // The pre-lock read is unlocked on purpose and is not a race: nothing adds
    // an allocation to this transaction without holding its FOR UPDATE lock,
    // which is taken below, and the set is re-read under that lock before
    // anything is written.
    await lockUpdatePurchases(tx, id, data);
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
    assertLedgerTransferUpdateAllowed(before, data);
    const accountId =
      data.accountId === undefined
        ? before.accountId
        : await resolveOrThrow(tx, "financialAccount", data.accountId);
    const sourceRefs = data.sourceRefs ?? before.sourceRefs;
    await lockFinancialEvidenceKeys(
      tx,
      "transaction-ref",
      sourceRefs.map((ref) => `${ref.source}\0${ref.externalId}`),
    );
    await assertSourceRefsAvailable(tx, sourceRefs, id);

    // `purchaseId` is input sugar only — there is no such column any more, so it
    // never reaches the physical update.
    const { purchaseId: _sugarOnly, ...writableData } = data;
    const values = buildPartialUpdateValues({ ...writableData, accountId });

    // The create input rejects a purchaseId/allocations pair that disagrees;
    // deriveUpdateData drops that refinement, so the same check belongs here
    // rather than silently letting one field win.
    assertAllocationShorthandAgrees(data);
    const state = await deriveUpdatedTransactionState(tx, id, before, data);
    await tx
      .update(financialTransaction)
      .set(values)
      .where(
        and(eq(financialTransaction.id, id), notDeleted(financialTransaction)),
      );
    const changes = computeChanges(before, { ...before, ...values }, [
      ...entityFieldModels.financialTransaction.audit,
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
    await applyUpdatedAllocations(tx, id, data, state, actor);

    // Data-quality targets come from applyAllocationChanges, which knows the
    // union of before/after purchases; nothing else here can name one.
  });
  return { output: await getFinancialTransactionByID(db, id), entityId: id };
}

export const FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY = {
  "ImportHunt.financialTransactionId": {
    code: "block-import-hunt",
    effect: "block",
    description:
      "An active or historical import hunt retains its source transaction.",
  },
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

/** Evidence for a ledger transfer stays until the transfer releases it. */
const refuseTransferEvidence = async (
  tx: DrizzleTransaction,
  ids: FinancialTransactionId[],
) => {
  const [linkedEvidence] = await tx
    .select({ id: financialTransaction.id })
    .from(financialTransaction)
    .where(
      and(
        inArray(financialTransaction.id, ids),
        sql`${financialTransaction.ledgerTransferId} IS NOT NULL`,
      ),
    )
    .limit(1);
  if (linkedEvidence)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A financial transaction that evidences a ledger transfer cannot be deleted until the transfer releases it.",
    );
};

/**
 * Quality targets come from the allocations as well as the mirror: a
 * transaction split across two purchases has a NULL mirror, so reading only
 * that column would leave both purchases' data-quality exceptions stale.
 */
const touchAllocatedPurchases = async (
  tx: DrizzleTransaction,
  ids: FinancialTransactionId[],
) => {
  // includes-deleted: this delete just tombstoned the allocations.
  const allocations = await tx
    .select({ purchaseId: financialTransactionAllocation.purchaseId })
    .from(financialTransactionAllocation)
    .where(inArray(financialTransactionAllocation.transactionId, ids));
  await touchDataQualityTargets(tx, {
    purchaseIds: uniq(allocations.map((row) => row.purchaseId)),
  });
};

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

export const financialTransactionRepository = entityRepository(
  "financialTransaction",
  {
    lifecycle: { delete: FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY },
    get: getFinancialTransactionByShortcode,
    list: listFinancialTransactions,
    create: createFinancialTransaction,
    update: updateFinancialTransaction,
    deleteHooks: {
      beforeDelete: refuseTransferEvidence,
      afterDelete: touchAllocatedPurchases,
    },
  },
);
