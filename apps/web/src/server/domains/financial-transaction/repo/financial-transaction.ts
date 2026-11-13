import type { ActorContext } from "@cubby/schemas/context";
import { financialTransactionRawOut as rawFinancialTransactionOut } from "@cubby/schemas/entity-contracts/financialTransaction";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type {
  FinancialTransactionCreateInput,
  FinancialTransactionSourceOptionsOut,
  FinancialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import {
  financialTransactionAllocationIntegrity,
  financialTransactionKind,
  financialTransactionSettlementViolation,
} from "@cubby/schemas/financial-transaction";
import { descriptorProcessors } from "@cubby/schemas/financial-transaction-fields";
import {
  type FinancialTransactionId,
  type FinancialTransactionShortcode,
  parseShortcodeFor,
  type PurchaseId,
  type PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { minorToMoney, moneyToMinor } from "@cubby/shared";
import { and, getTableColumns, inArray, isNotNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { capitalize, sortBy, uniq } from "es-toolkit";
import { z } from "zod";

import {
  financialTransactionRepositoryReadSchema,
  financialTransactionSchemaBindings,
} from "~/entity/generated/entity-schema-bindings.financialTransaction.gen";
import type { Database, DrizzleTransaction } from "~/server/db";
import { minorToDollarsSql } from "~/server/db/computed/money";
import { sourceTransactionSettlements } from "~/server/db/computed/source-transaction-settlement-sql";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import { DECLARED_EDGE_DELETE_HOOKS } from "~/server/db/generated/declared-edges.gen";
import {
  buildPartialUpdateValues,
  databaseForTransaction,
  getDb,
  notDeleted,
  touchUpdatedAt,
  withTransaction,
} from "~/server/db/helpers";
import { quotedTable } from "~/server/db/helpers/related";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  financialTransaction,
  financialTransactionAllocation,
  purchase,
  sourceOccurrence,
} from "~/server/db/schema";
import {
  emptySpendingCategorySummary,
  loadTransactionSpendingCategorySummaries,
} from "~/server/domains/expense/repo/expense-category-summary";
import { bankTransactionWrites } from "~/server/domains/financial-transaction/repo/bank-event";
import {
  createBankTransactions,
  updateBankTransactions,
} from "~/server/domains/financial-transaction/repo/bank-mutations";
import { allocationIntegrityDefectSql } from "~/server/domains/financial-transaction/repo/financial-allocation-integrity";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import { financialTransactionItemizationSql } from "~/server/domains/financial-transaction/repo/financial-reconciliation";
import {
  acceptFreshFinancialSources,
  assertFinancialSourceRefsAvailableFor,
  financialSourceRefsFor,
  financialSourceReferenceRows,
  lockFreshFinancialSources,
  refuseFreshFinancialSource,
  replaceFinancialSourceRefsFor,
  lockFinancialSourceOccurrences,
} from "~/server/domains/financial-transaction/repo/financial-source-evidence";
import {
  type AllocationInput,
  type AllocationSnapshot,
  allocationChangeAudits,
  allocationConfirmsMerchant,
  applyAllocationChanges,
  assertAllocationSetValid,
  assertPurchasesLive,
  countLiveAllocations,
  readAllocations,
  resolveAllocationInputs,
  writeAllocationSets,
} from "~/server/domains/financial-transaction/repo/financial-transaction-allocations";
import { financialTransactionSearch } from "~/server/domains/financial-transaction/repo/search-read-financial-transaction";
import {
  findSettlementConflicts,
  refuseSettlementConflictsFor,
} from "~/server/domains/financial-transaction/repo/settlement-conflicts";
import type { FinancialTransactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import { transactionDollars } from "~/server/domains/financial-transaction/repo/transaction-money";
import {
  financialTransactionCoverageSql,
  financialTransactionEvidenceFieldResolutionsSql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { evidenceAuditEntries } from "~/server/domains/transaction-import/repo/intake-audit";
import { enrichFinancialTransactionVendorRead } from "~/server/domains/vendor/repo/merchant-vendor-inference";
import {
  financialAllocationItems,
  possibleVendorLabel,
  sourceRefsLabel,
} from "~/server/entity-kernel/repo/detail-display-labels";
import {
  asActor,
  createEntityReader,
  defineMutationWriter,
  defineRepository,
  type MutationReceipt,
} from "~/server/entity-kernel/repo/repository";
import { WriteLayer } from "~/server/entity-kernel/repo/write-layer";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
} from "~/server/generic/audit-log/repo/audit-log";
import { listScaffold } from "~/server/generic/list/repo/list";
import { resolveAllOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { enterWriteTransaction } from "~/server/kernel/gate";

const accountName = sql<string | null>`(
  SELECT fa.name FROM "FinancialAccount" fa
  WHERE fa.id = "FinancialTransaction"."accountId" AND ${notDeleted("fa")}
)`;

// Mirrors `parseBankDescriptor`: the same POSIX patterns, first match wins.
const descriptorProcessorSql = sql`CASE ${sql.join(
  descriptorProcessors.map(
    (processor) =>
      sql`WHEN ${financialTransaction.rawDescription} ~* ${processor.pattern} THEN ${processor.value}::text`,
  ),
  sql` `,
)} END`;

// Partial bindings retain field validators; full reads retain settlement refinements.
const transactionFields = z.object(rawFinancialTransactionOut.shape);

export const financialTransactionScaffold = listScaffold(
  "financialTransaction",
  financialTransaction,
  {
    readSchema: financialTransactionRepositoryReadSchema,
    rows: {
      settlementRefs: sql`SELECT owner,source,"externalId" FROM ${financialSourceReferenceRows} reference`,
      acceptedSourceRecords: sql`SELECT "transaction" AS "owner", "record" FROM (${sourceTransactionSettlements}) accepted`,
    },
    derived: {
      // An unnamed merchant leads a descending list.
      merchant: { sql: sql`${financialTransaction.merchant}`, nulls: "high" },
      itemization: sql`${financialTransactionItemizationSql('"FinancialTransaction"."id"')}`,
      // Live: an integrity defect must surface without waiting for a quality refresh.
      allocationIntegrity: sql`CASE WHEN ${allocationIntegrityDefectSql(quotedTable(financialTransaction))} THEN ${financialTransactionAllocationIntegrity.enum.defect}::text END`,
      descriptorProcessor: descriptorProcessorSql,
    },
    read: {
      title: sql`COALESCE(${financialTransaction.merchant}::text, ${financialTransaction.rawDescription}::text, initcap(${financialTransaction.kind}::text))`,
      search: financialTransactionSearch,
      // Keys outside the read schema are helper columns the bindings read.
      columns: {
        spendingCategoryName: sql<
          string | null
        >`(SELECT name FROM "SpendingCategory" WHERE id = "FinancialTransaction"."spendingCategoryId" AND ${notDeleted("SpendingCategory")})`,
        fieldResolutions: financialTransactionEvidenceFieldResolutionsSql(
          "FinancialTransaction",
        ),
        accountName,
        coverageSummary: financialTransactionCoverageSql(
          "FinancialTransaction",
        ),
        ledgerTransferShortcode: sql<
          string | null
        >`(SELECT shortcode FROM "LedgerTransfer" WHERE id = "FinancialTransaction"."ledgerTransferId")`,
        spendingCategoryShortcode: sql<
          string | null
        >`(SELECT shortcode FROM "SpendingCategory" WHERE id = "FinancialTransaction"."spendingCategoryId" AND ${notDeleted("SpendingCategory")})`,
        accountShortcode: sql<string>`(SELECT fa.shortcode FROM "FinancialAccount" fa WHERE fa.id = "FinancialTransaction"."accountId")`,
        // Ordered by shortcode so the field is stable across reads rather than
        // following whatever order the planner happens to produce.
        allocationRows: sql<
          { purchaseId: string; amount: number; confirmsMerchant: boolean }[]
        >`COALESCE((
          SELECT jsonb_agg(jsonb_build_object('purchaseId', ap.shortcode, 'amount', (${minorToDollarsSql(sql`aa."amountMinor"`, "numeric")}), 'confirmsMerchant', aa."confirmsMerchant") ORDER BY ap.shortcode)
          FROM "FinancialTransactionAllocation" aa
          JOIN "Purchase" ap ON ap."id" = aa."purchaseId"
          WHERE aa."transactionId" = "FinancialTransaction"."id" AND ${notDeleted("aa")}
        ), '[]'::jsonb)`,
      },
      bindings: (bind) => {
        const helper = z.object({
          coverageSummary: rawFinancialTransactionOut.shape.coverage,
          ledgerTransferShortcode: z.string().nullable(),
          spendingCategoryShortcode: z.string().nullable(),
          accountShortcode: z.string(),
          allocationRows: z.array(
            z.object({
              purchaseId: z.string(),
              amount: z.coerce.number(),
              confirmsMerchant: z.boolean(),
            }),
          ),
        });
        const refs = bind.batch(({ db, rows }) =>
          financialSourceRefsFor(
            db,
            rows.map((row) => row.id),
          ),
        );
        const categories = bind.batch(({ db, rows }) =>
          loadTransactionSpendingCategorySummaries(
            db,
            rows.map((row) => row.id),
          ),
        );
        const inferences = bind.batch(async ({ db, rows }) => {
          const enriched = await enrichFinancialTransactionVendorRead(
            db,
            rows.map((row) => {
              const values = helper.parse(row);
              return {
                id: parseShortcodeFor("financialTransaction", row.shortcode),
                kind: financialTransactionKind.parse(row.kind),
                status: rawFinancialTransactionOut.shape.status.parse(
                  row.status,
                ),
                // Generic entity reads already decode storage money.
                amount: rawFinancialTransactionOut.shape.amount.parse(
                  row.amount,
                ),
                merchant: row.merchant,
                allocations: values.allocationRows,
                ledgerTransferId: values.ledgerTransferShortcode,
              };
            }),
          );
          return new Map(
            rows.map((row, index) => [
              row.id,
              enriched[index]?.vendorInference,
            ]),
          );
        });
        return [
          bind(transactionFields.pick({ displayName: true }), (row) => ({
            // `merchant`/`rawDescription` are both nullable statement fields;
            // `kind` is the last resort so an imported row with neither still
            // gets a non-blank identity.
            displayName:
              row.merchant?.trim() ||
              row.rawDescription?.trim() ||
              capitalize(row.kind.replaceAll("_", " ")),
          })),
          bind(
            transactionFields.pick({
              coverage: true,
              bookingCoverage: true,
              documentCoverage: true,
              itemizationCoverage: true,
              productsCoverage: true,
            }),
            (row) => {
              const coverage = helper.parse(row).coverageSummary;
              return {
                coverage,
                bookingCoverage: coverage.booking,
                documentCoverage: coverage.document,
                itemizationCoverage: coverage.itemization,
                productsCoverage: coverage.products,
              };
            },
          ),
          bind(transactionFields.pick({ spendingCategoryId: true }), (row) => {
            const code = helper.parse(row).spendingCategoryShortcode;
            return {
              spendingCategoryId: code
                ? parseShortcodeFor("spendingCategory", code)
                : null,
            };
          }),
          bind(transactionFields.pick({ accountId: true }), (row) => ({
            accountId: parseShortcodeFor(
              "financialAccount",
              helper.parse(row).accountShortcode,
            ),
          })),
          refs.fields(
            transactionFields.pick({ sourceRefs: true, sourceRefsLabel: true }),
            (row, loaded) => {
              const sourceRefs = loaded.get(row.id) ?? [];
              return {
                sourceRefs,
                sourceRefsLabel: sourceRefsLabel(sourceRefs),
              };
            },
          ),
          bind(
            transactionFields.pick({
              allocations: true,
              allocationItems: true,
              purchaseId: true,
              ledgerTransferId: true,
            }),
            (row) => {
              const values = helper.parse(row);
              const allocations = values.allocationRows.map((value) => ({
                purchaseId: parseShortcodeFor("purchase", value.purchaseId),
                amount: value.amount,
                confirmsMerchant: value.confirmsMerchant,
              }));
              return {
                allocations,
                allocationItems: financialAllocationItems(allocations),
                // DERIVED, not stored: the sole Purchase this transaction
                // settled, or null when it settled none or several.
                purchaseId:
                  allocations.length === 1 ? allocations[0]!.purchaseId : null,
                ledgerTransferId: values.ledgerTransferShortcode
                  ? parseShortcodeFor(
                      "ledgerTransfer",
                      values.ledgerTransferShortcode,
                    )
                  : null,
              };
            },
          ),
          categories.fields(
            transactionFields.pick({ spendingCategorySummary: true }),
            (row, loaded) => ({
              spendingCategorySummary:
                loaded.get(row.id) ?? emptySpendingCategorySummary(),
            }),
          ),
          inferences.fields(
            transactionFields.pick({
              vendorInference: true,
              possibleVendorLabel: true,
            }),
            (row, loaded) => {
              const vendorInference = loaded.get(row.id);
              if (vendorInference === undefined)
                throw new Error(
                  "Financial transaction vendor inference was not loaded",
                );
              return {
                vendorInference,
                possibleVendorLabel: possibleVendorLabel(vendorInference),
              };
            },
          ),
        ];
      },
    },
  },
);

const financialTransactionReader = createEntityReader({
  entity: "financialTransaction",
  scaffold: financialTransactionScaffold,
  output: rawFinancialTransactionOut,
});

const getFinancialTransactionByID = financialTransactionReader.getByID;

export const createFinancialTransaction = defineMutationWriter({
  entity: "financialTransaction",
  read: async (
    receipt: MutationReceipt<"financialTransaction">,
    db: Database,
    _data: FinancialTransactionCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await getFinancialTransactionByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: FinancialTransactionCreateInput,
    actor: ActorContext,
  ) => {
    const [id] = await withTransaction(db, (tx) =>
      createFinancialTransactions(tx, [data], actor),
    );
    return readOutput({ entityId: id! });
  },
});

/**
 * The create path for one or many transactions: one account resolution, one
 * locked occurrence proof, one identity insert, one acceptance statement and
 * one audit insert. Named allocations follow as one set. Rows are created and
 * returned in input order.
 */
export async function createFinancialTransactions(
  tx: DrizzleTransaction,
  inputs: readonly FinancialTransactionCreateInput[],
  actor: ActorContext,
): Promise<FinancialTransactionId[]> {
  if (!inputs.length) return [];
  const accountIds = await resolveAllOrThrow(
    tx,
    "financialAccount",
    inputs.map((data) => data.accountId),
  );
  const created = await createFinancialTransactionRows(
    tx,
    inputs.map((data, index) => ({ data, accountId: accountIds[index]! })),
    actor,
  );
  const named = await resolveAllocationInputs(
    tx,
    inputs.flatMap((data) =>
      data.allocations.length > 0
        ? data.allocations
        : data.purchaseId
          ? [{ purchaseId: data.purchaseId, amount: data.amount }]
          : [],
    ),
  );
  if (named.length) {
    // `purchaseId` is sugar for one allocation of the full amount; the zod
    // refinement has already rejected a purchaseId/allocations pair that
    // disagrees, so either source can be taken verbatim here.
    let offset = 0;
    const sets = inputs.flatMap((data, index) => {
      const count =
        data.allocations.length > 0
          ? data.allocations.length
          : data.purchaseId
            ? 1
            : 0;
      const next = named.slice(offset, (offset += count));
      return count ? [{ transactionId: created[index]!.id, data, next }] : [];
    });
    await assertPurchasesLive(
      tx,
      sets.flatMap(({ next }) => next.map((row) => row.purchaseId)),
    );
    for (const { data, next } of sets)
      assertAllocationSetValid({
        transactionAmount: data.amount,
        kind: data.kind,
        next,
      });
    await refuseSettlementConflictsFor(
      tx,
      sets.map(({ transactionId, next }) => ({
        transactionId,
        purchaseIds: next.map((row) => row.purchaseId),
      })),
    );
    await writeAllocationSets(tx, sets, new Map(), actor);
    await applyAllocationChanges(tx, {
      transactionIds: sets.map(({ transactionId }) => transactionId),
      before: new Map(),
      actor,
    });
  }
  return created.map((row) => row.id);
}

/**
 * Insert fresh transactions on resolved accounts and accept their sources:
 * the occurrence proof and row locks precede the insert, acceptance and the
 * create and evidence audits follow it. Returns the stored rows in input order.
 */
export async function createFinancialTransactionRows(
  tx: DrizzleTransaction,
  inputs: readonly {
    data: Omit<FinancialTransactionCreateInput, "accountId">;
    accountId: FinancialTransactionDbRow["accountId"];
  }[],
  actor: ActorContext,
) {
  if (!inputs.length) return [];
  await enterWriteTransaction(tx, { lane: "money", mode: "member" });
  // One locked occurrence FK owns acceptance; retained aliases never grant it.
  const proof = await lockFreshFinancialSources(
    tx,
    inputs.map(({ data, accountId }) => ({
      refs: data.sourceRefs,
      accountId,
      amount: data.amount,
    })),
  );
  if (proof.refusal) return refuseFreshFinancialSource(proof.refusal);
  const layer = new WriteLayer(tx);
  const created = await insertFreshFinancialTransactions(
    layer,
    inputs,
    proof.owners,
    actor,
  );
  await layer.flushAudits();
  return created;
}

/**
 * Append validated bank inputs, accept their sources and stage provenance audits.
 */
export async function insertFreshFinancialTransactions(
  layer: WriteLayer,
  inputs: readonly {
    data: Omit<FinancialTransactionCreateInput, "accountId">;
    accountId: FinancialTransactionDbRow["accountId"];
  }[],
  owners: Awaited<ReturnType<typeof lockFreshFinancialSources>>["owners"],
  actor: ActorContext,
) {
  if (!inputs.length) return [];
  const created = await createBankTransactions(
    databaseForTransaction(layer.tx),
    inputs,
    actor,
  );
  const acceptedSourceChanges = await acceptFreshFinancialSources(
    layer.tx,
    created.map((row, index) => ({
      transactionId: row.id,
      refs: inputs[index]!.data.sourceRefs,
    })),
    owners,
  );
  layer.audit(actor, [
    ...evidenceAuditEntries(
      "sourceOccurrence",
      acceptedSourceChanges.before,
      acceptedSourceChanges.after,
    ),
    ...created.map((row) => ({
      entityKind: "financialTransaction" as const,
      entityId: row.id,
      action: "create" as const,
    })),
  ]);
  return created;
}

const allocationStateFields = [
  "allocations",
  "purchaseId",
  "amount",
  "kind",
  "status",
  "accountId",
  "transactionDate",
  "postedDate",
] satisfies readonly (keyof FinancialTransactionUpdateData)[];

type FinancialTransactionDbRow = FinancialTransactionDollars;

export const lockUpdatePurchases = async (
  tx: DrizzleTransaction,
  updates: readonly {
    id: FinancialTransactionId;
    data: FinancialTransactionUpdateData;
  }[],
) => {
  if (!updates.length) return;
  const incomingCodes = updates.flatMap(({ data }) => [
    ...(data.allocations?.map((row) => row.purchaseId) ?? []),
    ...(data.purchaseId ? [data.purchaseId] : []),
  ]);
  const current = await readAllocations(
    tx,
    updates.map(({ id }) => id),
  );
  const incoming = await resolveAllOrThrow(tx, "purchase", incomingCodes);
  await assertPurchasesLive(
    tx,
    uniq([
      ...[...current.values()].flat().map((row) => row.purchaseId),
      ...incoming,
    ]),
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

const deriveUpdatedTransactionState = (
  allocationCount: number,
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
  const amountChanged =
    moneyToMinor(nextAmount) !== moneyToMinor(before.amount);
  if (amountChanged && allocationCount >= 2) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `This transaction's amount is split across ${allocationCount} purchases. Re-allocate it first, then the amount will follow.`,
    );
  }
  return { nextKind, nextAmount, allocationCount, amountChanged };
};

/** The allocation rows an update names, before resolving their Purchases. */
const namedUpdateAllocations = (
  data: FinancialTransactionUpdateData,
  state: ReturnType<typeof deriveUpdatedTransactionState>,
) =>
  data.allocations !== undefined
    ? data.allocations
    : data.purchaseId
      ? [{ purchaseId: data.purchaseId, amount: state.nextAmount }]
      : data.purchaseId === null
        ? []
        : undefined;

const requestedUpdateAllocations = (
  id: FinancialTransactionId,
  state: ReturnType<typeof deriveUpdatedTransactionState>,
  before: Awaited<ReturnType<typeof readAllocations>>,
  named: AllocationInput[] | undefined,
): AllocationInput[] | null => {
  if (named !== undefined) return named;
  if (!state.amountChanged || state.allocationCount !== 1) return null;
  const sole = before.get(id)?.[0];
  return sole
    ? [
        {
          purchaseId: sole.purchaseId,
          amount: state.nextAmount,
          confirmsMerchant: sole.confirmsMerchant,
        },
      ]
    : null;
};

type AllocationUpdate = {
  id: FinancialTransactionId;
  data: FinancialTransactionUpdateData;
  state: ReturnType<typeof deriveUpdatedTransactionState>;
  priorCharge: FinancialTransactionDbRow;
};

/** Every allocation-changing update's set, conflicts and follow-ups together. */
const applyUpdatedAllocations = async (
  tx: DrizzleTransaction,
  updates: readonly AllocationUpdate[],
  actor: ActorContext,
  options: FinancialTransactionUpdateOptions,
  /** Read and share-locked by the caller in this transaction. */
  prepared?: { before: AllocationSnapshot; resolved: AllocationInput[] },
) => {
  if (!updates.length) return;
  const ids = updates.map(({ id }) => id);
  const before = prepared?.before ?? (await readAllocations(tx, ids));
  const named = updates.map(({ data, state }) =>
    namedUpdateAllocations(data, state),
  );
  const resolved =
    prepared?.resolved ??
    (await resolveAllocationInputs(
      tx,
      named.flatMap((rows) => rows ?? []),
    ));
  let offset = 0;
  const nexts = updates.map(({ id, state }, index) => {
    const rows = named[index];
    const inputs = rows && resolved.slice(offset, (offset += rows.length));
    return requestedUpdateAllocations(id, state, before, inputs);
  });
  if (!prepared)
    await assertPurchasesLive(
      tx,
      nexts.flatMap((next) => next?.map((row) => row.purchaseId) ?? []),
    );
  for (const [index, next] of nexts.entries())
    if (next !== null)
      assertAllocationSetValid({
        transactionAmount: updates[index]!.state.nextAmount,
        kind: financialTransactionKind.parse(updates[index]!.state.nextKind),
        next,
      });
  await writeAllocationSets(
    tx,
    updates.flatMap(({ id }, index) => {
      const next = nexts[index];
      return next === null || next === undefined
        ? []
        : [{ transactionId: id, next }];
    }),
    before,
    actor,
  );
  // Every write that names a purchase or changes the charge's account, kind
  // or dates is checked; a conflict the charge already carried before this
  // write (a statement re-import touching an already-wrong allocation) is
  // not new and stays visible through the Purchase conflict checks instead.
  if (!options.acknowledgeSettlementConflicts) {
    const checks = [];
    for (const [index, { id, data, priorCharge }] of updates.entries()) {
      const held = (before.get(id) ?? []).map((row) => row.purchaseId);
      const chargeChanged = (
        ["accountId", "kind", "transactionDate", "postedDate"] as const
      ).some((key) => data[key] !== undefined);
      const nextNamed = nexts[index]?.map((row) => row.purchaseId) ?? held;
      checks.push({
        transactionId: id,
        purchaseIds: chargeChanged
          ? nextNamed
          : nextNamed.filter((purchaseId) => !held.includes(purchaseId)),
        existing: await findSettlementConflicts(tx, {
          accountId: priorCharge.accountId,
          kind: financialTransactionKind.parse(priorCharge.kind),
          transactionDate:
            priorCharge.transactionDate ?? priorCharge.postedDate,
          purchaseIds: held,
        }),
      });
    }
    await refuseSettlementConflictsFor(tx, checks);
  }
  await applyAllocationChanges(tx, { transactionIds: ids, before, actor });
};

/**
 * A booking's settlement: each live transaction allocates its full amount to
 * one Purchase. The caller holds the transactions' source and reviewed-booking
 * locks; this takes the Purchase share locks, then the transaction rows, and
 * shares the update path's validation, conflict check and follow-ups.
 */
export async function allocateFinancialBookings(
  tx: DrizzleTransaction,
  bookings: readonly {
    row: FinancialTransactionDbRow;
    allocation: {
      purchaseId: PurchaseShortcode;
      amount: number;
      confirmsMerchant?: boolean;
    };
  }[],
  actor: ActorContext,
): Promise<FinancialTransactionId[]> {
  if (!bookings.length) return [];
  const ids = bookings.map(({ row }) => row.id);
  const resolved = await resolveAllocationInputs(
    tx,
    bookings.map(({ allocation }) => allocation),
  );
  const before = await readAllocations(tx, ids);
  // LOCK ORDER: Purchase rows first, THEN the transaction rows.
  await assertPurchasesLive(
    tx,
    uniq([
      ...[...before.values()].flat().map((row) => row.purchaseId),
      ...resolved.map((row) => row.purchaseId),
    ]),
  );
  await tx
    .select({ id: financialTransaction.id })
    .from(financialTransaction)
    .where(
      and(
        inArray(financialTransaction.id, ids),
        notDeleted(financialTransaction),
      ),
    )
    .orderBy(financialTransaction.id)
    .for("update");
  await applyUpdatedAllocations(
    tx,
    bookings.map(({ row, allocation }) => {
      const data: FinancialTransactionUpdateData = {
        allocations: [allocation],
      };
      return {
        id: row.id,
        data,
        state: deriveUpdatedTransactionState(
          before.get(row.id)?.length ?? 0,
          row,
          data,
        ),
        priorCharge: row,
      };
    }),
    actor,
    {},
    { before, resolved },
  );
  return ids;
}

/**
 * Fresh bookings in a write layer: each transaction the layer created
 * allocates its full amount to one Purchase the layer created, so neither
 * side has prior allocations, competing settlements or another locker. The
 * update path's validation and allocation audit, with one allocation insert.
 */
export async function allocateFreshFinancialBookings(
  layer: WriteLayer,
  bookings: readonly {
    row: FinancialTransactionDbRow;
    purchase: { id: PurchaseId; shortcode: PurchaseShortcode };
    amount: number;
    confirmsMerchant?: boolean;
  }[],
  actor: ActorContext,
) {
  if (!bookings.length) return;
  const after: AllocationSnapshot = new Map();
  const sets = bookings.map(({ row, purchase, amount, confirmsMerchant }) => {
    const state = deriveUpdatedTransactionState(0, row, {
      allocations: [{ purchaseId: purchase.shortcode, amount }],
    });
    const next = [
      { purchaseId: purchase.id, amount: state.nextAmount, confirmsMerchant },
    ];
    assertAllocationSetValid({
      transactionAmount: state.nextAmount,
      kind: financialTransactionKind.parse(state.nextKind),
      next,
    });
    after.set(row.id, [
      {
        purchaseId: purchase.id,
        purchaseShortcode: purchase.shortcode,
        amount: minorToMoney(moneyToMinor(state.nextAmount)),
        confirmsMerchant: allocationConfirmsMerchant(
          undefined,
          next[0]!,
          actor,
        ),
      },
    ]);
    return { transactionId: row.id, next };
  });
  await writeAllocationSets(layer.tx, sets, new Map(), actor);
  layer.audit(
    actor,
    allocationChangeAudits(
      sets.map(({ transactionId }) => transactionId),
      new Map(),
      after,
    ).audits,
  );
}

/** Write-path options only `finance.allocate_settlement` sets. */
export type FinancialTransactionUpdateOptions = {
  /** The caller records the conflict's data exception in the same transaction. */
  acknowledgeSettlementConflicts?: boolean;
};

export const updateFinancialTransaction = defineMutationWriter({
  entity: "financialTransaction",
  read: async (
    receipt: MutationReceipt<"financialTransaction">,
    db: Database,
    _shortcode: FinancialTransactionShortcode,
    _data: FinancialTransactionUpdateData,
    _actor: ActorContext,
    _options: FinancialTransactionUpdateOptions = {},
  ) => ({
    output: await getFinancialTransactionByID(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: FinancialTransactionShortcode,
    data: FinancialTransactionUpdateData,
    actor: ActorContext,
    options: FinancialTransactionUpdateOptions = {},
  ) => {
    const [id] = await updateFinancialTransactions(
      db,
      [{ shortcode, data }],
      actor,
      options,
    );
    return readOutput({ entityId: id!, shortcode });
  },
});

const transactionColumns = Object.keys(getTableColumns(financialTransaction));

/**
 * The update path for one or many transactions under one set of locks: each
 * lock, read and check takes one statement for the whole set, row updates
 * with the same values share one statement, and allocation follow-ups run
 * together. Returns ids in input order; a transaction may appear once.
 */
export async function updateFinancialTransactions(
  db: Database,
  updates: readonly {
    shortcode: FinancialTransactionShortcode;
    data: FinancialTransactionUpdateData;
  }[],
  actor: ActorContext,
  options: FinancialTransactionUpdateOptions = {},
): Promise<FinancialTransactionId[]> {
  if (!updates.length) return [];
  if (
    new Set(updates.map((update) => update.shortcode)).size !== updates.length
  )
    throw new Error("One transaction update batch names a transaction twice");
  const ids = await resolveAllOrThrow(
    db,
    "financialTransaction",
    updates.map((update) => update.shortcode),
  );
  await withTransaction(db, async (tx) => {
    await enterWriteTransaction(tx, { lane: "money", mode: "member" });
    await lockFinancialEvidenceKeys(
      tx,
      "reviewed-booking",
      ids.map((id) => `transaction:${id}`),
    );
    const sourceOwners = await lockFinancialSourceOccurrences(
      tx,
      updates.flatMap(({ data }) => data.sourceRefs ?? []),
      ids,
    );
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
    const allocating = updates.flatMap(({ data }, index) =>
      allocationStateFields.some((field) => data[field] !== undefined)
        ? [{ id: ids[index]!, data }]
        : [],
    );
    await lockUpdatePurchases(tx, allocating);
    await tx
      .select({ id: financialTransaction.id })
      .from(financialTransaction)
      .where(
        and(
          inArray(financialTransaction.id, ids),
          notDeleted(financialTransaction),
        ),
      )
      .orderBy(financialTransaction.id)
      .for("update");
    const currentSourceOwners = await tx
      .select({ id: sourceOccurrence.id })
      .from(sourceOccurrence)
      .where(inArray(sourceOccurrence.acceptedTransactionId, ids));
    if (
      currentSourceOwners.some(
        (owner) => !sourceOwners.some((locked) => locked.id === owner.id),
      )
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Source ownership expanded while locking the transaction; retry with current evidence.",
      );
    const beforeRows = new Map(
      (
        await tx.query.financialTransaction.findMany({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(
                  inArray(financialTransaction.id, ids),
                  notDeleted(financialTransaction),
                ),
              ),
          },
        })
      ).map((row) => [row.id, transactionDollars(row)]),
    );
    const befores = updates.map(({ shortcode }, index) => {
      const before = beforeRows.get(ids[index]!);
      if (!before)
        throw createAppError(
          "FINANCIAL_TRANSACTION_NOT_FOUND",
          `Financial transaction not found: ${shortcode}`,
        );
      return before;
    });
    for (const [index, { shortcode, data }] of updates.entries()) {
      assertLedgerTransferUpdateAllowed(befores[index]!, data);
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
          where: {
            RAW: (expense, { eq }) =>
              relationalSql(
                expense,
                and(
                  eq(expense.bookingTransactionCode, shortcode),
                  notDeleted(expense),
                ),
              ),
          },
        });
        if (liveBooking)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "This transaction has booked Expenses. Review its spending correction before changing it to a non-spending kind.",
          );
      }
    }
    const accountCodes = updates.flatMap(({ data }) =>
      data.accountId === undefined ? [] : [data.accountId],
    );
    const resolvedAccounts = await resolveAllOrThrow(
      tx,
      "financialAccount",
      accountCodes,
    );
    let account = 0;
    const accountIds = updates.map(({ data }, index) =>
      data.accountId === undefined
        ? befores[index]!.accountId
        : resolvedAccounts[account++]!,
    );
    const inspected = updates.flatMap(({ data }, index) =>
      data.sourceRefs === undefined ? [] : [ids[index]!],
    );
    const beforeSourceRefs = await financialSourceRefsFor(tx, inspected);
    await assertFinancialSourceRefsAvailableFor(
      tx,
      updates.flatMap(({ data }, index) =>
        data.sourceRefs === undefined
          ? []
          : [{ refs: data.sourceRefs, exceptTransactionId: ids[index]! }],
      ),
    );

    // `purchaseId` is input sugar only — there is no such column any more, so it
    // never reaches the physical update. `sourceRefs` addresses occurrences or retained evidence aliases.
    const valuesFor = updates.map(({ data }, index) => {
      const {
        purchaseId: _sugarOnly,
        sourceRefs: _references,
        ...writableData
      } = data;
      return buildPartialUpdateValues({
        ...writableData,
        amount:
          data.amount === undefined ? undefined : moneyToMinor(data.amount),
        accountId: accountIds[index]!,
      });
    });
    // The create input rejects a purchaseId/allocations pair that disagrees;
    // deriveUpdateData drops that refinement, so the same check belongs here
    // rather than silently letting one field win.
    for (const { data } of updates) assertAllocationShorthandAgrees(data);
    const allocationCounts = await countLiveAllocations(
      tx,
      allocating.map(({ id }) => id),
    );
    const states = updates.map(({ data }, index) =>
      allocationStateFields.some((field) => data[field] !== undefined)
        ? deriveUpdatedTransactionState(
            allocationCounts.get(ids[index]!) ?? 0,
            befores[index]!,
            data,
          )
        : null,
    );
    // Reconciled values become decisions; ordinary metadata keeps its writer.
    const columnValues = valuesFor.map((values) =>
      Object.fromEntries(
        Object.entries(values).filter(([key]) =>
          transactionColumns.includes(key),
        ),
      ),
    );
    await updateBankTransactions(
      databaseForTransaction(tx),
      updates.map((_update, index) => ({
        id: ids[index]!,
        values: columnValues[index]!,
      })),
      actor,
    );
    for (const [index, values] of columnValues.entries()) {
      const ordinary = Object.fromEntries(
        Object.entries(values).filter(
          ([field]) => !bankTransactionWrites.columns.includes(field),
        ),
      );
      if (Object.keys(ordinary).length)
        await tx
          .update(financialTransaction)
          .set(ordinary)
          .where(
            and(
              inArray(financialTransaction.id, [ids[index]!]),
              notDeleted(financialTransaction),
            ),
          );
    }
    const acceptedSourceChanges = await replaceFinancialSourceRefsFor(
      tx,
      updates.flatMap(({ data }, index) =>
        data.sourceRefs === undefined
          ? []
          : [{ transactionId: ids[index]!, refs: data.sourceRefs }],
      ),
    );
    const audits = evidenceAuditEntries(
      "sourceOccurrence",
      acceptedSourceChanges.before,
      acceptedSourceChanges.after,
    );
    for (const [index, { data }] of updates.entries()) {
      const id = ids[index]!;
      const before = befores[index]!;
      const values = valuesFor[index]!;
      const beforeState = {
        ...before,
        sourceRefs:
          data.sourceRefs === undefined ? [] : (beforeSourceRefs.get(id) ?? []),
      };
      // Stored references have no order; compare in the canonical order
      // `financialSourceRefsFor` reads them in, so a reordered resubmission is no diff.
      const canonicalRefs = sortBy(data.sourceRefs ?? beforeState.sourceRefs, [
        (ref) => ref.source,
        (ref) => ref.externalId,
      ]);
      const changes = computeChanges(
        beforeState,
        {
          ...beforeState,
          ...values,
          amount: data.amount ?? before.amount,
          sourceRefs: canonicalRefs,
        },
        [...entityFieldModels.financialTransaction.audit],
      );
      if (changes)
        audits.push({
          entityKind: "financialTransaction",
          entityId: id,
          action: "update",
          changes,
        });
    }
    await logAuditEntries(tx, actor, audits);

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
    await applyUpdatedAllocations(
      tx,
      updates.flatMap(({ data }, index) => {
        const state = states[index];
        return state
          ? [{ id: ids[index]!, data, state, priorCharge: befores[index]! }]
          : [];
      }),
      actor,
      options,
    );

    // Data-quality targets come from applyAllocationChanges, which knows the
    // union of before/after purchases; nothing else here can name one.
  });
  return ids;
}

/** Evidence for a ledger transfer stays until the transfer releases it. */
export const refuseTransferEvidence = async (
  tx: DrizzleTransaction,
  ids: FinancialTransactionId[],
) => {
  const [linkedEvidence] = await tx
    .select({ id: financialTransaction.id })
    .from(financialTransaction)
    .where(
      and(
        inArray(financialTransaction.id, ids),
        isNotNull(financialTransaction.ledgerTransferId),
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
export const touchAllocatedPurchases = async (
  tx: DrizzleTransaction,
  ids: FinancialTransactionId[],
) => {
  // includes-deleted: this delete just tombstoned the allocations.
  const allocations = await tx
    .select({ purchaseId: financialTransactionAllocation.purchaseId })
    .from(financialTransactionAllocation)
    .where(inArray(financialTransactionAllocation.transactionId, ids));
  await touchUpdatedAt(
    tx,
    purchase,
    allocations.map((row) => row.purchaseId),
  );
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
    SELECT evidence.source,count(DISTINCT evidence.owner)::int AS count FROM ${financialSourceReferenceRows} evidence
    JOIN "FinancialTransaction" ft ON ft.id=evidence.owner AND ${notDeleted("ft")}
    GROUP BY evidence.source ORDER BY count(DISTINCT evidence.owner) DESC,evidence.source
  `);
  return rows.rows.map((row) => ({
    source: row.source,
    count: Number(row.count),
  }));
}

export const financialTransactionRepository = defineRepository(
  "financialTransaction",
  {
    schemas: financialTransactionSchemaBindings,
    lifecycle: { delete: DECLARED_EDGE_DELETE_POLICIES.financialTransaction },
    scaffold: financialTransactionScaffold,
    create: asActor(createFinancialTransaction),
    update: asActor(
      (
        db: Database,
        shortcode: FinancialTransactionShortcode,
        data: FinancialTransactionUpdateData,
        actor: ActorContext,
      ) => updateFinancialTransaction(db, shortcode, data, actor),
    ),
    updateRead: (ctx, shortcode, data, fields) =>
      updateFinancialTransaction.read(
        fields,
        ctx.db,
        shortcode,
        data,
        ctx.actorContext,
      ),
    deleteHooks: DECLARED_EDGE_DELETE_HOOKS.financialTransaction,
  },
);

export const lockFinancialTransactionDeletion = async (
  tx: DrizzleTransaction,
  ids: FinancialTransactionId[],
): Promise<void> => {
  await lockFinancialEvidenceKeys(
    tx,
    "reviewed-booking",
    ids.map((id) => `transaction:${id}`),
  );
  const refs = await financialSourceRefsFor(tx, ids);
  await lockFinancialEvidenceKeys(
    tx,
    "transaction-ref",
    [...refs.values()]
      .flat()
      .map((ref) => JSON.stringify([ref.source, ref.externalId])),
  );
  await tx
    .select({ id: sourceOccurrence.id })
    .from(sourceOccurrence)
    .where(inArray(sourceOccurrence.acceptedTransactionId, ids))
    .orderBy(sourceOccurrence.id)
    .for("update");
};
