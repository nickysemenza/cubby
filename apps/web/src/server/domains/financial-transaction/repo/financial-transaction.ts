import type { ActorContext } from "@cubby/schemas/context";
import { financialTransactionRawOut as rawFinancialTransactionOut } from "@cubby/schemas/entity-contracts/financialTransaction";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
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
} from "@cubby/schemas/identifiers";
import { cents } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { capitalize, sortBy, uniq } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { sourceTransactionSettlements } from "~/server/db/computed/source-transaction-settlement-sql";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  buildPartialUpdateValues,
  getDb,
  notDeleted,
  touchUpdatedAt,
  withTransaction,
} from "~/server/db/helpers";
import { quotedTable } from "~/server/db/helpers/related";
import {
  financialTransaction,
  financialTransactionAllocation,
  purchase,
} from "~/server/db/schema";
import {
  emptySpendingCategorySummary,
  loadTransactionSpendingCategorySummaries,
} from "~/server/domains/expense/repo/expense-category-summary";
import { allocationIntegrityDefectSql } from "~/server/domains/financial-transaction/repo/financial-allocation-integrity";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import { financialTransactionItemizationSql } from "~/server/domains/financial-transaction/repo/financial-reconciliation";
import {
  type AllocationInput,
  applyAllocationChanges,
  assertAllocationSetValid,
  assertPurchasesLive,
  countLiveAllocations,
  readAllocations,
  resolveAllocationInputs,
  writeAllocationSet,
} from "~/server/domains/financial-transaction/repo/financial-transaction-allocations";
import { financialTransactionSearch } from "~/server/domains/financial-transaction/repo/search-read-financial-transaction";
import {
  findSettlementConflicts,
  refuseSettlementConflicts,
} from "~/server/domains/financial-transaction/repo/settlement-conflicts";
import {
  financialTransactionCoverageSql,
  financialTransactionEvidenceFieldResolutionsSql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { runStepInputListRows } from "~/server/domains/run/repo/run-step-input";
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
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import {
  assertSettlementRefsAvailable,
  replaceSettlementRefs,
  settlementRefsFor,
} from "~/server/generic/entity-links/repo/entity-external-ids";
import { listScaffold } from "~/server/generic/list/repo/list";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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
    rows: {
      runStepInputs: runStepInputListRows("financialTransaction"),
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
          SELECT jsonb_agg(jsonb_build_object('purchaseId', ap.shortcode, 'amount', aa."amount", 'confirmsMerchant', aa."confirmsMerchant") ORDER BY ap.shortcode)
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
          settlementRefsFor(
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
                amount: row.amount,
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
        await refuseSettlementConflicts(tx, {
          transactionId: created.id,
          purchaseIds: requested.map((row) => row.purchaseId),
        });
        await writeAllocationSet(tx, created.id, requested, new Map(), actor);
        await applyAllocationChanges(tx, {
          transactionIds: [created.id],
          before: new Map(),
          actor,
        });
      }
      return created.id;
    });
    return readOutput({ entityId: id });
  },
});

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

type FinancialTransactionDbRow = typeof financialTransaction.$inferSelect;

export const lockUpdatePurchases = async (
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
    ? [
        {
          purchaseId: sole.purchaseId,
          amount: state.nextAmount,
          confirmsMerchant: sole.confirmsMerchant,
        },
      ]
    : null;
};

const applyUpdatedAllocations = async (
  tx: DrizzleTransaction,
  id: FinancialTransactionId,
  data: FinancialTransactionUpdateData,
  state: Awaited<ReturnType<typeof deriveUpdatedTransactionState>>,
  actor: ActorContext,
  options: FinancialTransactionUpdateOptions,
  priorCharge: FinancialTransactionDbRow,
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
    await writeAllocationSet(tx, id, next, before, actor);
  }
  // Every write that names a purchase or changes the charge's account, kind
  // or dates is checked; a conflict the charge already carried before this
  // write (a statement re-import touching an already-wrong allocation) is
  // not new and stays visible through the Purchase conflict checks instead.
  const held = (before.get(id) ?? []).map((row) => row.purchaseId);
  const chargeChanged = (
    ["accountId", "kind", "transactionDate", "postedDate"] as const
  ).some((key) => data[key] !== undefined);
  const named = next?.map((row) => row.purchaseId) ?? held;
  const recheck = chargeChanged
    ? named
    : named.filter((purchaseId) => !held.includes(purchaseId));
  if (!options.acknowledgeSettlementConflicts)
    await refuseSettlementConflicts(tx, {
      transactionId: id,
      purchaseIds: recheck,
      existing: await findSettlementConflicts(tx, {
        accountId: priorCharge.accountId,
        kind: financialTransactionKind.parse(priorCharge.kind),
        transactionDate: priorCharge.transactionDate ?? priorCharge.postedDate,
        purchaseIds: held,
      }),
    });
  await applyAllocationChanges(tx, { transactionIds: [id], before, actor });
};

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
    const id = await resolveOrThrow(db, "financialTransaction", shortcode);
    const changesAllocationState = allocationStateFields.some(
      (field) => data[field] !== undefined,
    );
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
      if (changesAllocationState) await lockUpdatePurchases(tx, id, data);
      await tx
        .select({ id: financialTransaction.id })
        .from(financialTransaction)
        .where(
          and(
            eq(financialTransaction.id, id),
            notDeleted(financialTransaction),
          ),
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
          where: (expense, { eq }) =>
            and(
              eq(expense.bookingTransactionCode, shortcode),
              notDeleted(expense),
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
      const inspectSourceRefs = data.sourceRefs !== undefined;
      const beforeSourceRefs = inspectSourceRefs
        ? ((await settlementRefsFor(tx, [id])).get(id) ?? [])
        : [];
      const sourceRefs = data.sourceRefs ?? beforeSourceRefs;
      if (inspectSourceRefs) {
        await lockFinancialEvidenceKeys(
          tx,
          "transaction-ref",
          sourceRefs.map((ref) => `${ref.source}\0${ref.externalId}`),
        );
        await assertSettlementRefsAvailable(tx, sourceRefs, id);
      }

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
      const state = changesAllocationState
        ? await deriveUpdatedTransactionState(tx, id, before, data)
        : null;
      await tx
        .update(financialTransaction)
        .set(values)
        .where(
          and(
            eq(financialTransaction.id, id),
            notDeleted(financialTransaction),
          ),
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
      if (state)
        await applyUpdatedAllocations(
          tx,
          id,
          data,
          state,
          actor,
          options,
          before,
        );

      // Data-quality targets come from applyAllocationChanges, which knows the
      // union of before/after purchases; nothing else here can name one.
    });
    return readOutput({ entityId: id });
  },
});

const FINANCIAL_TRANSACTION_DELETE_EDGE_POLICY = {
  "EmailFinancialAssociation.transactionId": {
    code: "preserve-reviewed-email-association",
    effect: "preserve",
    description:
      "A reviewed Email association keeps naming the deleted transaction's tombstone; the review is history and is never rewritten.",
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
    SELECT fx."source" AS source, count(DISTINCT fx."entityId")::int AS count
    FROM "EntityExternalId" fx
    JOIN "FinancialTransaction" ft ON ft."id" = fx."entityId" AND ${notDeleted("ft")}
    WHERE fx."kind" = 'settlement_ref' AND ${notDeleted("fx")}
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
    deleteHooks: {
      beforeDelete: refuseTransferEvidence,
      afterDelete: touchAllocatedPurchases,
    },
  },
);
