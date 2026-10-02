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
import type { FinancialTransactionItemization } from "@cubby/schemas/financial-transaction-fields";
import {
  type FinancialTransactionId,
  type FinancialTransactionShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type { SpendingCategorySummary } from "@cubby/schemas/spending-classification";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { capitalize, sortBy, uniq } from "es-toolkit";

import { projectListRows } from "~/entity/list-read-schema";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import { gapCondition } from "~/server/repo/data-quality/sql";
import { touchDataQualityTargets } from "~/server/repo/data-quality/touch";
import {
  buildPartialUpdateValues,
  correlated,
  eqAny,
  getDb,
  type ListReadIntent,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  assertSettlementRefsAvailable,
  replaceSettlementRefs,
  type SettlementRef,
  settlementRefsFor,
} from "~/server/repo/entity-external-ids";
import { lockFinancialEvidenceKeys } from "~/server/repo/financial-evidence";
import { financialTransactionItemizationSql } from "~/server/repo/financial-reconciliation";
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
import { listScaffold } from "~/server/repo/list";
import {
  listGroupFields,
  loadListGroup,
  wantsListGroup,
  type ListProjection,
} from "~/server/repo/list-projection";
import {
  enrichFinancialTransactionsWithVendorInference,
  enrichFinancialTransactionVendorRead,
} from "~/server/repo/merchant-vendor-inference";
import { cents } from "~/server/repo/money";
import {
  asActor,
  defineRepository,
  listOn,
  onDb,
} from "~/server/repo/repository";
import { createEntityReader } from "~/server/repo/repository";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  emptySpendingCategorySummary,
  loadTransactionSpendingCategorySummaries,
} from "./expense-category-summary";
import { parseCompleteListRead } from "./list-read-adapters";
import {
  financialTransactionCoverageSql,
  financialTransactionEvidenceFieldResolutionsSql,
} from "./purchase-evidence-policy";

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
  spendingCategoryShortcode: sql<
    string | null
  >`(SELECT shortcode FROM "SpendingCategory" WHERE id = "FinancialTransaction"."spendingCategoryId" AND "deletedAt" IS NULL)`,
  spendingCategoryName: sql<
    string | null
  >`(SELECT name FROM "SpendingCategory" WHERE id = "FinancialTransaction"."spendingCategoryId" AND "deletedAt" IS NULL)`,
  evidenceExpectation: financialTransaction.evidenceExpectation,
  coverage: financialTransactionCoverageSql("FinancialTransaction"),
  fieldResolutions: financialTransactionEvidenceFieldResolutionsSql(
    "FinancialTransaction",
  ),
  sourceCategory: financialTransaction.sourceCategory,
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
  // A raw string in a select field: Drizzle would strip a column prefix.
  itemization: correlated<FinancialTransactionItemization>(
    financialTransactionItemizationSql('"FinancialTransaction"."id"'),
  ),
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
  const ids = rows.map((row) => row.id);
  const [dataQualities, sourceRefs, categorySummaries] = await Promise.all([
    loadDataQualities(db, "financialTransaction", ids),
    settlementRefsFor(db, ids),
    loadTransactionSpendingCategorySummaries(db, ids),
  ]);
  return enrichFinancialTransactionsWithVendorInference(
    db,
    rows.map((row) =>
      // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
      toOut(
        row,
        dataQualities.get(row.id)!,
        sourceRefs.get(row.id) ?? [],
        categorySummaries.get(row.id) ?? emptySpendingCategorySummary(),
      ),
    ),
  );
};

const toOut = (
  row: FinancialTransactionRow,
  dataQuality: DataQuality,
  sourceRefs: SettlementRef[],
  spendingCategorySummary: SpendingCategorySummary,
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
    spendingCategoryId: row.spendingCategoryShortcode
      ? parseShortcodeFor("spendingCategory", row.spendingCategoryShortcode)
      : null,
    spendingCategoryName: row.spendingCategoryName,
    fieldResolutions: row.fieldResolutions,
    spendingCategorySummary,
    evidenceExpectation: row.evidenceExpectation,
    bookingCoverage: row.coverage.booking,
    documentCoverage: row.coverage.document,
    itemizationCoverage: row.coverage.itemization,
    productsCoverage: row.coverage.products,
    coverage: row.coverage,
    sourceCategory: row.sourceCategory,
    sourceRefs,
    notes: row.notes,
    allocations,
    ledgerTransferId: row.ledgerTransferShortcode
      ? parseShortcodeFor("ledgerTransfer", row.ledgerTransferShortcode)
      : null,
    accountName: row.accountName,
    itemization: row.itemization,
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

const selectTransactionsRead = (
  db: Database | DrizzleTransaction,
  projection: ListProjection,
) => {
  const {
    ledgerTransferShortcode,
    accountShortcode,
    allocations,
    accountName,
    spendingCategoryName,
    fieldResolutions,
    itemization,
    ...core
  } = columns;
  return unwrapDb(db)
    .select({
      ...core,
      ...listGroupFields(projection, "relations", () => ({
        accountShortcode,
        accountName,
        spendingCategoryName,
      })),
      ...listGroupFields(projection, "derived", () => ({ fieldResolutions })),
      ...listGroupFields(projection, ["relations", "derived"], () => ({
        ledgerTransferShortcode,
        allocations,
      })),
      ...listGroupFields(projection, "derived", () => ({ itemization })),
    })
    .from(financialTransaction);
};
const hydrateTransactionsRead = async (
  db: Database,
  rows: Awaited<ReturnType<typeof selectTransactionsRead>>,
  projection: ListProjection,
) => {
  const ids = rows.map((row) => row.id);
  const [qualities, refs, categorySummaries] = await Promise.all([
    loadListGroup(projection, "quality", () =>
      loadDataQualities(db, "financialTransaction", ids),
    ),
    loadListGroup(projection, "relations", () => settlementRefsFor(db, ids)),
    loadListGroup(projection, "derived", () =>
      loadTransactionSpendingCategorySummaries(db, ids),
    ),
  ]);
  const values = rows.map((row) => {
    const allocations = (row.allocations ?? []).map((value) => ({
      purchaseId: parseShortcodeFor("purchase", value.purchaseId),
      amount: Number(value.amount),
    }));
    return {
      ...row,
      fieldResolutions: row.fieldResolutions,
      ...listGroupFields(projection, "derived", () => ({
        spendingCategorySummary:
          categorySummaries?.get(row.id) ?? emptySpendingCategorySummary(),
      })),
      bookingCoverage: row.coverage.booking,
      documentCoverage: row.coverage.document,
      itemizationCoverage: row.coverage.itemization,
      productsCoverage: row.coverage.products,
      spendingCategoryId: row.spendingCategoryShortcode
        ? parseShortcodeFor("spendingCategory", row.spendingCategoryShortcode)
        : null,
      id: parseShortcodeFor("financialTransaction", row.shortcode),
      displayName:
        row.merchant?.trim() ||
        row.rawDescription?.trim() ||
        capitalize(row.kind.replaceAll("_", " ")),
      ...listGroupFields(projection, "relations", () => ({
        accountId: parseShortcodeFor("financialAccount", row.accountShortcode!),
        sourceRefs: refs?.get(row.id) ?? [],
      })),
      ...listGroupFields(projection, ["relations", "derived"], () => ({
        allocations,
        purchaseId:
          allocations.length === 1 ? allocations[0]!.purchaseId : null,
        ledgerTransferId: row.ledgerTransferShortcode
          ? parseShortcodeFor("ledgerTransfer", row.ledgerTransferShortcode)
          : null,
      })),
      ...listGroupFields(projection, "quality", () => ({
        dataQuality: qualities!.get(row.id)!,
      })),
    };
  });
  if (wantsListGroup(projection, "derived")) {
    const inferences = await enrichFinancialTransactionVendorRead(
      db,
      rows.map((row) => ({
        id: parseShortcodeFor("financialTransaction", row.shortcode),
        kind: financialTransactionKind.parse(row.kind),
        status: financialTransactionOut.shape.status.parse(row.status),
        amount: row.amount,
        merchant: row.merchant,
        allocations: row.allocations ?? [],
        ledgerTransferId: row.ledgerTransferShortcode ?? null,
      })),
    );
    values.forEach((value, index) =>
      Object.assign(value, {
        vendorInference: inferences[index]!.vendorInference,
      }),
    );
  }
  return projectListRows("financialTransaction", values, projection);
};

/**
 * "Carries a live settlement reference matching the filters". Both filters
 * constrain the SAME reference row, so a transaction that took its source
 * from one reference and its externalId from another does not match.
 *
 * Emptiness is normalized on `.length`, NOT nullishness: `oneOrMany`'s array
 * branch has no `.min(1)`, so `[]` is valid input and is not nullish. An empty
 * list means "no constraint on that field", never "no constraint at all".
 */
const refsCondition = (
  sources?: string[],
  externalIds?: string[],
): SQL | undefined => {
  const src = sources?.length ? sources : undefined;
  const ext = externalIds?.length ? externalIds : undefined;
  if (!src && !ext) return undefined;
  return sql`EXISTS (
    SELECT 1 FROM "EntityExternalId" fx
    WHERE fx."entityId" = "FinancialTransaction"."id"
      AND fx."kind" = 'settlement_ref' AND fx."deletedAt" IS NULL
      ${
        src
          ? sql`AND fx."source" IN (${sql.join(
              src.map((value) => sql`${value}`),
              sql`, `,
            )})`
          : sql``
      }
      ${
        ext
          ? sql`AND fx."externalId" IN (${sql.join(
              ext.map((value) => sql`${value}`),
              sql`, `,
            )})`
          : sql``
      }
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
    filters.itemization
      ? sql`${sql.raw(financialTransactionItemizationSql('"FinancialTransaction"."id"'))} = ${filters.itemization}`
      : undefined,
    filters.allocationIntegrity === "defect"
      ? gapCondition(
          "financialTransaction",
          "financial_transaction_allocation_integrity",
          financialTransaction,
        )
      : undefined,
    refsCondition(
      filters.source ? [filters.source].flat() : undefined,
      filters.externalId ? [filters.externalId].flat() : undefined,
    ),
  ]);
}

export const listFinancialTransactionsRead = async (
  db: Database,
  filters: FinancialTransactionFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
  projection: ListProjection = { kind: "full" },
) =>
  financialTransactionScaffold.list(
    db,
    { filters, sorts, pagination, readIntent, projection },
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
        selectTransactionsRead(db, projection)
          .where(page.where)
          .orderBy(...page.orderBy)
          .limit(page.limit)
          .offset(page.offset),
      hydrate: (rows) => hydrateTransactionsRead(db, rows, projection),
    },
  );

export const listFinancialTransactions = async (
  db: Database,
  filters: FinancialTransactionFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
) => {
  const result = await listFinancialTransactionsRead(
    db,
    filters,
    sorts,
    pagination,
    readIntent,
  );
  return parseCompleteListRead(
    financialTransactionOut,
    Promise.resolve(result),
  );
};

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
const getFinancialTransactionByShortcode =
  financialTransactionReader.getByShortcode;

async function resolveForeignKeys(
  db: Database | DrizzleTransaction,
  data: Pick<FinancialTransactionCreateInput, "accountId" | "purchaseId">,
) {
  const accountId = await resolveOrThrow(
    db,
    "financialAccount",
    data.accountId,
  );
  return {
    accountId,
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
    // The global uniqueness guarantee that lets statement matching join on
    // (source, externalId) without a DISTINCT; the live unique backstops it.
    await assertSettlementRefsAvailable(tx, data.sourceRefs);
    const { allocations, sourceRefs, ...columns } = data;
    const created = await insertWithShortcode(tx, "financialTransaction", {
      ...columns,
      ...foreign,
    });
    await replaceSettlementRefs(tx, created.id, sourceRefs);
    await logAuditEntry(tx, actor, {
      entityKind: "financialTransaction",
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
    if (
      data.kind !== undefined &&
      ![
        "purchase",
        "refund",
        "adjustment",
        "fee",
        "interest",
        "income",
      ].includes(data.kind)
    ) {
      const liveBooking = await tx.query.expense.findFirst({
        where: (expense, { eq, isNull }) =>
          and(
            eq(expense.bookingTransactionCode, shortcode),
            isNull(expense.deletedAt),
          ),
      });
      if (liveBooking)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "This transaction has booked Expenses. Review its spending correction before changing it to a non-spending kind.",
        );
    }
    const accountId =
      data.accountId === undefined
        ? before.accountId
        : await resolveOrThrow(tx, "financialAccount", data.accountId);
    const beforeSourceRefs = (await settlementRefsFor(tx, [id])).get(id) ?? [];
    const sourceRefs = data.sourceRefs ?? beforeSourceRefs;
    await lockFinancialEvidenceKeys(
      tx,
      "transaction-ref",
      sourceRefs.map((ref) => `${ref.source}\0${ref.externalId}`),
    );
    await assertSettlementRefsAvailable(tx, sourceRefs, id);

    // `purchaseId` is input sugar only — there is no such column any more, so it
    // never reaches the physical update. `sourceRefs` lives in EntityExternalId.
    const {
      purchaseId: _sugarOnly,
      sourceRefs: _references,
      ...writableData
    } = data;
    const values = buildPartialUpdateValues({
      ...writableData,
      accountId,
    });

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
    if (data.sourceRefs !== undefined)
      await replaceSettlementRefs(tx, id, data.sourceRefs);
    const beforeState = { ...before, sourceRefs: beforeSourceRefs };
    // Stored references have no order; compare in the canonical order
    // `settlementRefsFor` reads them in, so a reordered resubmission is no diff.
    const canonicalRefs = sortBy(sourceRefs, [
      (ref) => ref.source,
      (ref) => ref.externalId,
    ]);
    const changes = computeChanges(
      beforeState,
      { ...beforeState, ...values, sourceRefs: canonicalRefs },
      [...entityFieldModels.financialTransaction.audit],
    );
    if (changes)
      await logAuditEntry(tx, actor, {
        entityKind: "financialTransaction",
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

const FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY = {
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
  "EntityExternalId.entityId": {
    code: "soft-delete-metadata",
    effect: "soft-delete",
    description:
      "The transaction's settlement references are soft-deleted with it, releasing each (source, externalId) so the same statement line can be recorded again.",
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
 * Distinct settlement-reference sources across live transactions, with the
 * number of transactions carrying each: one transaction carrying both a
 * `monarch` and a `zoro` reference counts once under each, which is what a
 * filter over "has a ref from this source" means.
 */
export async function financialTransactionSourceOptions(
  db: Database,
): Promise<FinancialTransactionSourceOptionsOut> {
  const rows = await getDb(db).execute<{ source: string; count: number }>(sql`
    SELECT fx."source" AS source, count(DISTINCT fx."entityId")::int AS count
    FROM "EntityExternalId" fx
    JOIN "FinancialTransaction" ft ON ft."id" = fx."entityId" AND ft."deletedAt" IS NULL
    WHERE fx."kind" = 'settlement_ref' AND fx."deletedAt" IS NULL
    GROUP BY 1
    ORDER BY count(DISTINCT fx."entityId") DESC, 1 ASC
  `);
  return rows.rows.map((row) => ({
    source: row.source,
    count: Number(row.count),
  }));
}

export const financialTransactionRepository = defineRepository(
  "financialTransaction",
  {
    lifecycle: { delete: FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY },
    get: onDb(getFinancialTransactionByShortcode),
    list: listOn(listFinancialTransactions),
    listRead: (ctx, filters, sorts, pagination, projection) =>
      listFinancialTransactionsRead(
        ctx.db,
        filters,
        sorts,
        pagination,
        "page",
        projection,
      ),
    create: asActor(createFinancialTransaction),
    update: asActor(updateFinancialTransaction),
    deleteHooks: {
      beforeDelete: refuseTransferEvidence,
      afterDelete: touchAllocatedPurchases,
    },
  },
);
