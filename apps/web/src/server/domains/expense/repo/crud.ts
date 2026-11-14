import type { ActorContext } from "@cubby/schemas/context";
import { type ExpenseUpdateInput } from "@cubby/schemas/entities/expense";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  EXPENSE_DATE_REQUIRED_MESSAGE,
  hasValidExpenseDate,
} from "@cubby/schemas/expense-fields";
import { resolveExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import type {
  ExpenseId,
  ExpenseShortcode,
  ProductId,
  ProductShortcode,
  ProjectId,
  ProjectShortcode,
  PurchaseId,
  PurchaseShortcode,
  SpendingCategoryId,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  DeleteExpensesWithPurchaseEffectsOut,
  ExpenseCreateInput,
} from "@cubby/schemas/project";
import { rawExpenseOut } from "@cubby/schemas/work-raw-read";
import { nullableMinorToMoney, nullableWholeCentToMinor } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import {
  buildPartialUpdateValues,
  databaseForTransaction,
  notDeleted,
  unwrapDb,
  withTransaction,
  withTransactionOn,
  touchUpdatedAt,
} from "~/server/db/helpers";
import { outer } from "~/server/db/helpers/related";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { expense, product, purchase } from "~/server/db/schema";
import { replaceExpenseAttributionRole } from "~/server/domains/expense/repo/expense-attribution";
import {
  requireLineRoleClassifier,
  type ExpenseLineRoleClassifier,
} from "~/server/domains/expense/repo/line-role-classifier";
import { createPurchaseEventRecords } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { updatePurchaseEventRecords } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import {
  assertExplicitSourceClaimsForAmountChange,
  replaceLedgerSourceClaims,
} from "~/server/domains/ledger-party/repo/ledger-source-claim";
import {
  pricingProductIds,
  syncChangedEffectivePrices,
} from "~/server/domains/product/repo/price-sync";
import { loadEffectiveProductPricesById } from "~/server/domains/product/repo/pricing";
import { foreignExpenseOriginSql } from "~/server/domains/purchase-import/repo/writer-policy";
import {
  findOrCreatePurchase,
  foldChargeInto,
  renameChargeOrderId,
} from "~/server/domains/purchase/repo/purchase";
import {
  assertClassificationPolicies,
  classificationFieldsToClear,
} from "~/server/domains/spending-category/repo/classification-field-policy";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import {
  createEntityCrud,
  defineMutationWriter,
  type MutationReceipt,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { validateProductPolicy } from "~/server/generic/inheritance/repo/inheritance-validation";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { enterWriteTransaction } from "~/server/kernel/gate";

import {
  expenseInheritanceReadExtras,
  validateExpenseInheritance,
  validateExpenseInheritances,
} from "./expense-inheritance";
import { assertQuantitySignMatchesCost, expenseAuditChildren } from "./helpers";
import { expenseScaffold } from "./lookup";

type ExpenseUpdateData = ExpenseUpdateInput["data"];

const assertExpenseDate = (cost: number | null, date: string | null) => {
  if (!hasValidExpenseDate({ cost, date })) {
    throw createAppError("CONSTRAINT_VIOLATION", EXPENSE_DATE_REQUIRED_MESSAGE);
  }
};

type ResolvedExpenseUpdate = Omit<
  ExpenseUpdateData,
  | "spendingCategoryId"
  | "vendor"
  | "orderId"
  | "projectId"
  | "productId"
  | "purchaseId"
  | "beneficiaries"
  | "funders"
  | "sourceClaims"
> & {
  spendingCategoryId?: SpendingCategoryId | null;
  projectId?: ProjectId | null;
  productId?: ProductId | null;
  purchaseId?: PurchaseId | null;
};

const resolveLiveProjectId = (
  tx: DrizzleTransaction,
  shortcode: ProjectShortcode,
): Promise<ProjectId> => resolveOrThrow(tx, "project", shortcode);

const resolveLiveProductId = (
  tx: DrizzleTransaction,
  shortcode: ProductShortcode,
): Promise<ProductId> => resolveOrThrow(tx, "product", shortcode);

const resolveLivePurchaseId = (
  tx: DrizzleTransaction,
  shortcode: PurchaseShortcode,
): Promise<PurchaseId> => resolveOrThrow(tx, "purchase", shortcode);

const expenseUpdateValues = (data: ResolvedExpenseUpdate) =>
  buildPartialUpdateValues({
    spendingCategoryId: data.spendingCategoryId,
    economicRole: data.economicRole,
    name: data.name,
    cost:
      data.cost === undefined ? undefined : nullableWholeCentToMinor(data.cost),
    date: data.date,
    lineKind: data.lineKind,
    lineBasis: data.lineBasis,
    costType: data.costType,
    trade: data.trade,
    url: data.url,
    notes: data.notes,
    future: data.future,
    projectId: data.projectId,
    productId: data.productId,
    productQuantity: data.productQuantity,
    purchaseId: data.purchaseId,
  });

const expenseCrud = createEntityCrud({
  table: expense,
  entity: "expense",
  scaffold: expenseScaffold,
  output: rawExpenseOut,
  toUpdate: expenseUpdateValues,
  auditUpdateFields: [...entityFieldModels.expense.audit],
});

/** One live Expense by internal id; throws when absent. */
export const readExpenseById = expenseCrud.getByID;
/** One live Expense by public code, or null. */
export const readExpense = expenseCrud.getByShortcode;

type ChargeResolutionCurrent = {
  purchaseId: PurchaseId | null;
  vendorName: string | null;
  orderId: string | null;
  lineCount: number;
};

const tryRenameCurrentCharge = async (
  tx: DrizzleTransaction,
  actor: ActorContext,
  current: ChargeResolutionCurrent | undefined,
  vendorName: string,
  requestedOrderId: string | null,
  orderIdProvided: boolean,
) => {
  if (
    !current?.purchaseId ||
    current.vendorName !== vendorName ||
    current.lineCount > 1 ||
    !orderIdProvided
  ) {
    return false;
  }
  return renameChargeOrderId(tx, current.purchaseId, requestedOrderId, actor);
};

const chargeVendorName = (
  provided: string | null | undefined,
  current: ChargeResolutionCurrent | undefined,
) => provided?.trim() || current?.vendorName || undefined;

const currentChargeIsUnchanged = (
  current: ChargeResolutionCurrent | undefined,
  vendorName: string,
  orderId: string | null | undefined,
  requestedOrderId: string | null,
) =>
  Boolean(
    current?.purchaseId &&
    current.vendorName === vendorName &&
    (orderId === undefined || current.orderId === requestedOrderId),
  );

const foldSupersededCharge = async (
  tx: DrizzleTransaction,
  actor: ActorContext,
  current: ChargeResolutionCurrent | undefined,
  target: PurchaseId,
) => {
  if (
    current?.purchaseId &&
    current.purchaseId !== target &&
    current.lineCount <= 1
  ) {
    await foldChargeInto(tx, current.purchaseId, target, actor);
  }
};

/**
 * Resolves vendor/order input inside the caller's transaction. `undefined`
 * means unchanged, `null` means detach, and vendorless order IDs are discarded.
 * Existing single-line charges are renamed rather than orphaned.
 */
const resolveCharge = async (
  tx: DrizzleTransaction,
  actor: ActorContext,
  data: {
    vendor?: string | null;
    orderId?: string | null;
    date?: string | null;
  },
  current?: ChargeResolutionCurrent,
): Promise<PurchaseId | null | undefined> => {
  if (data.vendor === undefined && data.orderId === undefined) return undefined;

  if (data.vendor === null) return null;

  // ⚠️ Falling back to the row's CURRENT vendor is load-bearing, not defensive.
  // Both Order # inline editors save `data: { orderId }` and nothing else
  // (expenselist.tsx and projects/shared.tsx), which is the ONLY shape the UI ever
  // sends for an order-id correction. Reading only `data.vendor` here made that
  // write a silent no-op — it appeared to save and changed nothing — which broke
  // the central purchase-import workflow of reconciling an order id against a
  // charge. A row with no vendor anywhere still drops the order id below, because
  // an order id alone can't name a transaction.
  const vendorName = chargeVendorName(data.vendor, current);
  if (!vendorName) return undefined;

  const requestedOrderId = data.orderId?.trim() || null;
  if (
    currentChargeIsUnchanged(
      current,
      vendorName,
      data.orderId,
      requestedOrderId,
    )
  ) {
    return undefined;
  }

  if (
    await tryRenameCurrentCharge(
      tx,
      actor,
      current,
      vendorName,
      requestedOrderId,
      data.orderId !== undefined,
    )
  )
    return undefined;

  const vendorId = await findOrCreateVendor(tx, vendorName);
  if (!data.date) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A dated Expense is required to create its Purchase.",
    );
  }
  const target = await findOrCreatePurchase(tx, {
    vendorId,
    orderId:
      data.orderId === undefined
        ? (current?.orderId ?? null)
        : requestedOrderId,
    // An existing purchase's date is purchase-level truth, not line-level input.
    date: data.date,
  });

  await foldSupersededCharge(tx, actor, current, target);

  return target;
};

const resolveOptionalProjectId = (
  tx: DrizzleTransaction,
  value: ExpenseUpdateData["projectId"],
) =>
  value === undefined
    ? Promise.resolve(undefined)
    : value === null
      ? Promise.resolve(null)
      : resolveLiveProjectId(tx, value);

const resolveOptionalProductId = (
  tx: DrizzleTransaction,
  value: ExpenseUpdateData["productId"],
) =>
  value === undefined
    ? Promise.resolve(undefined)
    : value === null
      ? Promise.resolve(null)
      : resolveLiveProductId(tx, value);

const resolveOptionalPurchaseId = (
  tx: DrizzleTransaction,
  value: ExpenseUpdateData["purchaseId"],
) =>
  value === undefined
    ? Promise.resolve(undefined)
    : value === null
      ? Promise.resolve(null)
      : resolveLivePurchaseId(tx, value);

const assertExpenseProductLink = (input: {
  productId: ProductId | null;
  lineKind: string;
  lineBasis: string;
  spendingCategoryId?: SpendingCategoryId | null;
  projectId?: ProjectId | null;
  productQuantity: number | null;
  cost: number | null;
}) => {
  assertClassificationPolicies("expense", input);
  if (input.productQuantity != null && input.productId === null) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Product quantity requires a linked product.",
    );
  }
  assertQuantitySignMatchesCost(input.cost, input.productQuantity);
};

/**
 * Single-row update. Wraps the factory's `update` so a `{vendor, orderId}` write
 * lands on `purchaseId` — the factory only knows how to set columns, and those
 * two aren't columns any more.
 *
 * An explicit `purchaseId` in the input short-circuits the name resolution
 * entirely (see the field's doc): an id is never a guess, so there's nothing to
 * resolve.
 *
 * ONE transaction covers all three phases — the `assertPurchaseLive` guard, the
 * charge resolution, and the factory's audited column write. That is a
 * correctness requirement, not a round-trip saving, and it's the same invariant
 * `createExpense` states below: `resolveCharge` can mint a vendor, mint a
 * charge, rename a charge in place, or fold one away, and the column write can
 * still fail afterwards (`updateLiveAndReturn` throws when the row was
 * concurrently soft-deleted). With separate boundaries those side-effects
 * committed and the failed write left behind an orphan vendor, an orphan charge,
 * or a charge folded away for no reason. Sharing the boundary also closes the
 * guard's TOCTOU window: a purchase soft-deleted between `assertPurchaseLive`
 * and the UPDATE can no longer be adopted.
 */
const readNestedExpenseAudit = async (
  db: Database | DrizzleTransaction,
  id: ExpenseId,
) => {
  const row = await unwrapDb(db).query.expense.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(table, and(eq(expense.id, id), notDeleted(expense))),
    },
    columns: { id: true },
    with: {
      attributions: {
        with: {
          ledgerParty: { columns: { shortcode: true, deletedAt: true } },
        },
      },
      sourceClaims: true,
    },
  });
  if (!row)
    throw createAppError("EXPENSE_NOT_FOUND", "Expense no longer exists");
  return expenseAuditChildren(row);
};

export const updateExpense = defineMutationWriter({
  entity: "expense",
  read: async (
    receipt: MutationReceipt<"expense"> & {
      priceAffectedProductIds: ProductId[];
    },
    db: Database,
    _shortcode: ExpenseShortcode,
    _data: ExpenseUpdateData,
    _actor: ActorContext,
  ) => ({
    output: await readExpenseById(db, receipt.entityId),
    entityId: receipt.entityId,
    priceAffectedProductIds: receipt.priceAffectedProductIds,
  }),
  write: async (
    readOutput,
    db: Database,
    shortcode: ExpenseShortcode,
    data: ExpenseUpdateData,
    actor: ActorContext,
  ) => {
    const {
      vendor: _vendor,
      orderId: _orderId,
      projectId,
      productId,
      purchaseId,
      beneficiaries,
      funders,
      sourceClaims,
      ...restColumns
    } = data;

    const needsResolve =
      data.purchaseId === undefined &&
      (data.vendor !== undefined || data.orderId !== undefined);

    const priceCanChange = [
      data.cost,
      data.future,
      data.productId,
      data.productQuantity,
      data.lineKind,
      data.lineBasis,
    ].some((value) => value !== undefined);
    const qualityCanChange = [
      data.cost,
      data.future,
      data.productId,
      data.purchaseId,
      data.lineKind,
      data.lineBasis,
    ].some((value) => value !== undefined);

    const loadUpdateState = async (tx: DrizzleTransaction) => {
      const id = await resolveOrThrow(tx, "expense", shortcode);
      const [locked] = await tx
        .select({ id: expense.id })
        .from(expense)
        .where(and(eq(expense.id, id), notDeleted(expense)))
        .for("update")
        .limit(1);
      if (!locked) {
        throw createAppError(
          "EXPENSE_NOT_FOUND",
          `Expense not found: ${shortcode}`,
        );
      }
      const nestedChanged =
        beneficiaries !== undefined ||
        funders !== undefined ||
        sourceClaims !== undefined;
      const nestedBefore = nestedChanged
        ? await readNestedExpenseAudit(tx, id)
        : undefined;
      const storedQuality = await tx.query.expense.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(table, and(eq(expense.id, id), notDeleted(expense))),
        },
        extras: expenseInheritanceReadExtras(),
        columns: {
          cost: true,
          date: true,
          productId: true,
          productQuantity: true,
          purchaseId: true,
          lineKind: true,
          lineBasis: true,
          projectId: true,
          spendingCategoryId: true,
          trade: true,
        },
      });
      const qualityBefore = storedQuality && {
        ...storedQuality,
        cost: nullableMinorToMoney(storedQuality.cost),
      };
      const nextCost =
        data.cost === undefined ? (qualityBefore?.cost ?? null) : data.cost;
      if (qualityBefore?.cost === null && nextCost !== null) {
        const [original] = await tx
          .select({ id: expense.id })
          .from(expense)
          .where(
            and(eq(expense.id, id), foreignExpenseOriginSql(outer(expense.id))),
          )
          .limit(1);
        if (original)
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "Use reviewed source reconciliation to price a foreign receipt line.",
          );
      }
      assertExpenseDate(
        nextCost,
        data.date === undefined ? (qualityBefore?.date ?? null) : data.date,
      );
      await assertExplicitSourceClaimsForAmountChange(
        tx,
        { expenseId: id },
        qualityBefore?.cost ?? null,
        nextCost,
        sourceClaims,
      );
      return { id, nestedBefore, qualityBefore, nextCost };
    };

    type UpdateState = Awaited<ReturnType<typeof loadUpdateState>>;

    const clearReclassifiedFields = (
      previous: UpdateState["qualityBefore"],
      update: ResolvedExpenseUpdate,
    ) => {
      for (const field of classificationFieldsToClear(
        "expense",
        previous ?? {},
        update,
      )) {
        Object.assign(update, { [field]: null });
      }
    };

    const normalizeAndAssertUpdateProductLink = (
      state: UpdateState,
      update: ResolvedExpenseUpdate,
    ) => {
      const previous = state.qualityBefore;
      clearReclassifiedFields(previous, update);
      if (update.productId === null && update.productQuantity === undefined) {
        update.productQuantity = null;
      }
      const resultingProductId =
        update.productId === undefined
          ? (previous?.productId ?? null)
          : update.productId;
      assertExpenseProductLink({
        productId: resultingProductId,
        lineKind: update.lineKind ?? previous?.lineKind ?? "principal",
        lineBasis: update.lineBasis ?? previous?.lineBasis ?? "item_line",
        productQuantity:
          update.productQuantity === undefined
            ? (previous?.productQuantity ?? null)
            : update.productQuantity,
        cost: state.nextCost,
      });
    };

    const validateUpdateState = async (
      tx: DrizzleTransaction,
      state: UpdateState,
      update: ResolvedExpenseUpdate,
      resultingPurchaseId: PurchaseId | null,
    ) => {
      const previous = state.qualityBefore;
      normalizeAndAssertUpdateProductLink(state, update);
      // Detaching a source preserves its effective attribution unless the same
      // edit explicitly replaces or resets that assignment.
      if (
        previous?.purchaseId &&
        resultingPurchaseId === null &&
        (update.lineKind ?? previous.lineKind) === "principal"
      ) {
        if (update.projectId === undefined)
          update.projectId = previous.effectiveProjectId;
        if (update.trade === undefined) update.trade = previous.effectiveTrade;
      }
      return validateExpenseInheritance(tx, {
        lineKind:
          update.lineKind ?? state.qualityBefore?.lineKind ?? "principal",
        projectId:
          update.projectId === undefined
            ? (state.qualityBefore?.projectId ?? null)
            : update.projectId,
        productId:
          update.productId === undefined
            ? (state.qualityBefore?.productId ?? null)
            : update.productId,
        purchaseId: resultingPurchaseId,
        trade:
          update.trade === undefined
            ? (state.qualityBefore?.trade ?? null)
            : update.trade,
      });
    };

    const resolveUpdateColumns = async (
      tx: DrizzleTransaction,
      state: UpdateState,
    ) => {
      const resolvedProjectId = await resolveOptionalProjectId(tx, projectId);
      const resolvedProductId = await resolveOptionalProductId(tx, productId);
      const explicitPurchaseId = await resolveOptionalPurchaseId(
        tx,
        purchaseId,
      );
      const update: ResolvedExpenseUpdate = {
        ...restColumns,
        spendingCategoryId:
          data.spendingCategoryId === undefined
            ? undefined
            : data.spendingCategoryId === null
              ? null
              : await resolveOrThrow(
                  tx,
                  "spendingCategory",
                  data.spendingCategoryId,
                ),
      };
      if (resolvedProductId === null && data.productQuantity === undefined) {
        update.productQuantity = null;
      }
      if (resolvedProjectId !== undefined) update.projectId = resolvedProjectId;
      if (resolvedProductId !== undefined) update.productId = resolvedProductId;
      normalizeAndAssertUpdateProductLink(state, update);
      const resultingProductId =
        update.productId === undefined
          ? (state.qualityBefore?.productId ?? null)
          : update.productId;
      return {
        explicitPurchaseId,
        resolvedProductId,
        resultingProductId,
        update,
      };
    };

    const applyNestedChanges = async (
      tx: DrizzleTransaction,
      state: UpdateState,
    ) => {
      if (beneficiaries !== undefined) {
        await replaceExpenseAttributionRole(
          tx,
          state.id,
          "beneficiary",
          beneficiaries ?? [],
          actor,
        );
      }
      if (funders !== undefined) {
        await replaceExpenseAttributionRole(
          tx,
          state.id,
          "funder",
          funders ?? [],
          actor,
        );
      }
      if (sourceClaims !== undefined) {
        await replaceLedgerSourceClaims(
          tx,
          { expenseId: state.id, targetAmount: state.nextCost },
          sourceClaims ?? [],
        );
      }
    };

    const auditNestedChanges = async (
      tx: DrizzleTransaction,
      state: UpdateState,
      output: ReturnType<typeof expenseAuditChildren>,
    ) => {
      if (!state.nestedBefore) return;
      const changes = computeChanges(state.nestedBefore, output, [
        "beneficiaries",
        "funders",
        "sourceClaims",
      ]);
      if (changes) {
        await logAuditEntry(tx, actor, {
          entityKind: "expense",
          entityId: state.id,
          action: "update",
          changes,
        });
      }
    };

    const currentCharge = async (
      tx: DrizzleTransaction,
      state: UpdateState,
    ) => {
      const existing = await tx.query.expense.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              and(eq(expense.id, state.id), notDeleted(expense)),
            ),
        },
        columns: { purchaseId: true, date: true },
        with: {
          purchase: {
            columns: { id: true, orderId: true, deletedAt: true },
            with: { vendor: { columns: { name: true, deletedAt: true } } },
          },
        },
      });
      const live =
        existing?.purchase?.deletedAt === null ? existing.purchase : undefined;
      const lineCount = live
        ? ((
            await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(expense)
              .where(and(eq(expense.purchaseId, live.id), notDeleted(expense)))
          )[0]?.n ?? 0)
        : 0;
      return {
        existing,
        current: {
          purchaseId: live ? (existing?.purchaseId ?? null) : null,
          vendorName:
            live?.vendor && live.vendor.deletedAt === null
              ? live.vendor.name
              : null,
          orderId: live?.orderId ?? null,
          lineCount,
        },
      };
    };

    return withTransaction(db, async (tx) => {
      await enterWriteTransaction(tx, { lane: "money", mode: "member" });
      const state = await loadUpdateState(tx);
      const {
        explicitPurchaseId,
        resolvedProductId,
        resultingProductId,
        update: rest,
      } = await resolveUpdateColumns(tx, state);

      const priceCandidates = priceCanChange
        ? pricingProductIds([
            state.qualityBefore?.productId,
            resultingProductId,
          ])
        : [];
      const pricesBefore = await loadEffectiveProductPricesById(
        tx,
        priceCandidates,
      );

      if (!needsResolve) {
        await applyNestedChanges(tx, state);
        const update = { ...rest };
        if (explicitPurchaseId !== undefined) {
          update.purchaseId = explicitPurchaseId;
        }
        await validateUpdateState(
          tx,
          state,
          update,
          explicitPurchaseId === undefined
            ? (state.qualityBefore?.purchaseId ?? null)
            : explicitPurchaseId,
        );
        await updatePurchaseEventRecords(
          databaseForTransaction(tx),
          "expense",
          [{ id: state.id, values: expenseUpdateValues(update) }],
          actor,
        );
        const receipt = { entityId: state.id };
        // A Product or category change can put a Product where its spending
        // category forbids one.
        await validateProductPolicy(tx, { expenseIds: [state.id] });
        if (state.nestedBefore)
          await auditNestedChanges(
            tx,
            state,
            await readNestedExpenseAudit(tx, state.id),
          );
        if (qualityCanChange) {
          await touchUpdatedAt(
            tx,
            product,
            [state.qualityBefore?.productId, resolvedProductId].filter(
              (value) => value != null,
            ),
          );
          await touchUpdatedAt(
            tx,
            purchase,
            [state.qualityBefore?.purchaseId, explicitPurchaseId].filter(
              (value) => value != null,
            ),
          );
        }
        const priceAffectedProductIds = await syncChangedEffectivePrices(
          tx,
          pricesBefore,
        );
        return readOutput(
          { ...receipt, priceAffectedProductIds },
          async () => ({
            output: await readExpenseById(tx, state.id),
            entityId: state.id,
            priceAffectedProductIds,
          }),
        );
      }

      // Count and charge metadata are read on `tx`; using the outer handle would
      // miss this transaction's writes and race the reassignment decision.
      const { existing, current } = await currentCharge(tx, state);
      const resolved = await resolveCharge(
        tx,
        actor,
        {
          ...data,
          date: data.date === undefined ? existing?.date : data.date,
        },
        current,
      );

      await applyNestedChanges(tx, state);

      const update = { ...rest };
      if (resolved !== undefined) update.purchaseId = resolved;
      await validateUpdateState(
        tx,
        state,
        update,
        resolved === undefined
          ? (state.qualityBefore?.purchaseId ?? null)
          : resolved,
      );
      await updatePurchaseEventRecords(
        databaseForTransaction(tx),
        "expense",
        [{ id: state.id, values: expenseUpdateValues(update) }],
        actor,
      );
      const receipt = { entityId: state.id };
      // A Product or category change can put a Product where its spending
      // category forbids one; a folded superseded charge can reclassify the
      // target Purchase's other lines, so check it whole once this line lands.
      await validateProductPolicy(
        tx,
        resolved ? { purchaseId: resolved } : { expenseIds: [state.id] },
      );
      if (state.nestedBefore)
        await auditNestedChanges(
          tx,
          state,
          await readNestedExpenseAudit(tx, state.id),
        );
      await touchUpdatedAt(
        tx,
        product,
        [state.qualityBefore?.productId, resolvedProductId].filter(
          (value) => value != null,
        ),
      );
      await touchUpdatedAt(
        tx,
        purchase,
        [state.qualityBefore?.purchaseId, resolved].filter(
          (value) => value != null,
        ),
      );
      const priceAffectedProductIds = await syncChangedEffectivePrices(
        tx,
        pricesBefore,
      );
      return readOutput({ ...receipt, priceAffectedProductIds }, async () => ({
        output: await readExpenseById(tx, state.id),
        entityId: state.id,
        priceAffectedProductIds,
      }));
    });
  },
});

export const createExpense = defineMutationWriter({
  entity: "expense",
  read: async (
    receipt: MutationReceipt<"expense"> & {
      priceAffectedProductIds: ProductId[];
    },
    db: Database,
    _data: ExpenseCreateInput,
    _actor: ActorContext,
    _classifyLineRole?: ExpenseLineRoleClassifier,
  ) => ({
    output: await readExpenseById(db, receipt.entityId),
    entityId: receipt.entityId,
    priceAffectedProductIds: receipt.priceAffectedProductIds,
  }),
  write: async (
    readOutput,
    db: Database,
    data: ExpenseCreateInput,
    actor: ActorContext,
    classifyLineRole?: ExpenseLineRoleClassifier,
  ) => {
    const { created, priceAffectedProductIds } = await createExpenses(
      db,
      [data],
      actor,
      classifyLineRole,
    );
    return readOutput({
      entityId: created[0]!.id,
      shortcode: created[0]!.shortcode,
      priceAffectedProductIds,
    });
  },
});

/** Optional shortcodes resolved in one statement, in input order. */
const resolveOptional = async <
  E extends "product" | "project" | "spendingCategory",
>(
  db: Database | DrizzleTransaction,
  entity: E,
  codes: readonly (string | null | undefined)[],
) => {
  const present = codes.filter((code): code is string => Boolean(code));
  const ids = await resolveAllOrThrow(db, entity, present);
  let index = 0;
  return codes.map((code) => (code ? ids[index++]! : null));
};

/**
 * The create path for one or many Expenses: each reference kind, the
 * inheritance check, the product policy and the audit take one statement for
 * the whole set, and rows are created and returned in input order. An input
 * that names no Purchase still resolves its charge on its own.
 */
type ExpenseReferences = {
  lineKind: ReturnType<typeof resolveExpenseLineKind>;
  projectId: ProjectId | null;
  productId: ProductId | null;
  purchaseId: PurchaseId | null;
};

/** One new Expense's classification, date and quantity checks on resolved references. */
function expenseCreateTuple(
  data: ExpenseCreateInput,
  references: ExpenseReferences,
) {
  const { lineKind, projectId, productId } = references;
  assertClassificationPolicies("expense", {
    lineKind,
    lineBasis: data.lineBasis ?? "item_line",
    productId,
    spendingCategoryId: data.spendingCategoryId ?? null,
    projectId,
  });
  if (data.productQuantity !== null && productId === null) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Product quantity requires a linked product.",
    );
  }
  assertExpenseDate(data.cost, data.date);
  assertQuantitySignMatchesCost(data.cost, data.productQuantity);
  return { ...references, trade: data.trade };
}

/** A new Expense's stored values. */
const expenseInsertValues = (
  data: ExpenseCreateInput,
  tuple: ReturnType<typeof expenseCreateTuple>,
  spendingCategoryId: SpendingCategoryId | null,
) => ({
  spendingCategoryId,
  economicRole: data.economicRole,
  name: data.name,
  cost: nullableWholeCentToMinor(data.cost),
  date: data.date,
  lineKind: tuple.lineKind,
  lineBasis: data.lineBasis,
  costType: data.costType,
  trade: data.trade,
  url: data.url,
  notes: data.notes,
  future: data.future,
  projectId: tuple.projectId,
  productId: tuple.productId,
  productQuantity: data.productQuantity,
  purchaseId: tuple.purchaseId,
});

/** A new Expense has no attributions or source claims to replace. */
async function writeNewExpenseLedgerRows(
  tx: DrizzleTransaction,
  inputs: readonly ExpenseCreateInput[],
  created: readonly { id: ExpenseId }[],
  actor: ActorContext,
) {
  for (const [index, data] of inputs.entries()) {
    const expenseId = created[index]!.id;
    if (data.beneficiaries?.length)
      await replaceExpenseAttributionRole(
        tx,
        expenseId,
        "beneficiary",
        data.beneficiaries,
        actor,
      );
    if (data.funders?.length)
      await replaceExpenseAttributionRole(
        tx,
        expenseId,
        "funder",
        data.funders,
        actor,
      );
    if (data.sourceClaims?.length)
      await replaceLedgerSourceClaims(
        tx,
        { expenseId, targetAmount: data.cost },
        data.sourceClaims,
      );
  }
}

export async function createExpenses(
  db: Database,
  inputs: readonly ExpenseCreateInput[],
  actor: ActorContext,
  classifyLineRole?: ExpenseLineRoleClassifier,
) {
  const preflightProductIds = await resolveOptional(
    db,
    "product",
    inputs.map((data) => data.productId),
  );
  const lineKinds: ReturnType<typeof resolveExpenseLineKind>[] = [];
  for (const [index, data] of inputs.entries())
    lineKinds.push(
      data.lineKind !== undefined || preflightProductIds[index]
        ? resolveExpenseLineKind({
            lineKind: data.lineKind,
            productId: preflightProductIds[index]!,
          })
        : await requireLineRoleClassifier(classifyLineRole)(db, actor, data),
    );
  return withTransaction(db, async (tx) => {
    await enterWriteTransaction(tx, { lane: "money", mode: "member" });
    // Same transaction as the insert: a vendor or charge created here must not
    // outlive a failed expense write.
    // A caller-supplied `purchaseId` skips `resolveCharge` entirely, so this is
    // the only place it gets checked for liveness: resolving through the
    // live-only resolver folds in what `assertPurchaseLive` used to check
    // separately (an FK proves the row exists, not that it isn't tombstoned).
    const explicitPurchaseIds = await resolveAllOrThrow(
      tx,
      "purchase",
      inputs.flatMap((data) => (data.purchaseId ? [data.purchaseId] : [])),
    );
    let explicit = 0;
    const purchaseIds: (PurchaseId | null)[] = [];
    for (const data of inputs)
      purchaseIds.push(
        data.purchaseId
          ? explicitPurchaseIds[explicit++]!
          : ((await resolveCharge(tx, actor, data)) ?? null),
      );
    const projectIds = await resolveOptional(
      tx,
      "project",
      inputs.map((data) => data.projectId),
    );
    const productIds = await resolveOptional(
      tx,
      "product",
      inputs.map((data) => data.productId),
    );
    const tuples = inputs.map((data, index) => {
      const productId = productIds[index]!;
      if (productId !== preflightProductIds[index]) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Expense Product changed while its receipt role was being resolved.",
        );
      }
      return expenseCreateTuple(data, {
        lineKind: lineKinds[index]!,
        projectId: projectIds[index]!,
        productId,
        purchaseId: purchaseIds[index]!,
      });
    });
    await validateExpenseInheritances(tx, tuples);
    const pricesBefore = await loadEffectiveProductPricesById(
      tx,
      pricingProductIds(productIds),
    );
    const categoryIds = await resolveOptional(
      tx,
      "spendingCategory",
      inputs.map((data) => data.spendingCategoryId),
    );
    const created = await createPurchaseEventRecords(
      tx,
      "expense",
      inputs.map((data, index) =>
        expenseInsertValues(data, tuples[index]!, categoryIds[index]!),
      ),
      actor,
    );
    await writeNewExpenseLedgerRows(tx, inputs, created, actor);
    await logAuditEntries(
      tx,
      actor,
      created.map((row) => ({
        entityKind: "expense" as const,
        entityId: row.id,
        action: "create" as const,
      })),
    );
    // The policy constrains Product-linked principal lines only.
    await validateProductPolicy(tx, {
      expenseIds: created.flatMap((row) => (row.productId ? [row.id] : [])),
    });
    await touchUpdatedAt(
      tx,
      product,
      uniq(productIds.filter((id) => id !== null)),
    );
    await touchUpdatedAt(
      tx,
      purchase,
      uniq(purchaseIds.filter((id) => id !== null)),
    );
    return {
      created,
      priceAffectedProductIds: await syncChangedEffectivePrices(
        tx,
        pricesBefore,
      ),
    };
  });
}

export const deleteExpensesWithPurchaseEffects = async (
  db: Database,
  shortcodes: ExpenseShortcode[],
  actor: ActorContext,
): Promise<{
  priceAffectedProductIds: ProductId[];
  result: DeleteExpensesWithPurchaseEffectsOut;
}> => {
  if (shortcodes.length === 0) {
    return {
      priceAffectedProductIds: [],
      result: {
        deleted: 0,
        deletedIds: [],
        affectedPurchaseIds: [],
        newlyEmptyPurchaseIds: [],
      },
    };
  }

  return await withTransaction(db, async (tx) => {
    await enterWriteTransaction(tx, { lane: "money", mode: "member" });
    return removeExpensesWithPurchaseEffects(
      tx,
      await resolveAllOrThrow(tx, "expense", shortcodes),
      actor,
    );
  });
};

/** The Expense delete policy by id; the kernel's removal of an Expense runs it too. */
export const removeExpensesWithPurchaseEffects = async (
  db: Database | DrizzleTransaction,
  ids: ExpenseId[],
  actor: ActorContext,
): Promise<{
  priceAffectedProductIds: ProductId[];
  result: DeleteExpensesWithPurchaseEffectsOut;
}> =>
  withTransactionOn(db, async (tx) => {
    const qualityTargets = await tx.query.expense.findMany({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(inArray(expense.id, ids), notDeleted(expense)),
          ),
      },
      columns: { shortcode: true, productId: true, purchaseId: true },
    });
    const affectedPurchaseDbIds = uniq(
      qualityTargets
        .map((row) => row.purchaseId)
        .filter((value): value is PurchaseId => value !== null),
    );
    const pricesBefore = await loadEffectiveProductPricesById(
      tx,
      pricingProductIds(qualityTargets.map((row) => row.productId)),
    );

    // The generic delete (policy dispositions + removal) joins this
    // transaction; the purchase and pricing effects around it are expense's.
    const { deleted } = await deleteByPolicy(tx, {
      entity: "expense",
      policy: DECLARED_EDGE_DELETE_POLICIES.expense,
      ids,
      actor,
    });

    await touchUpdatedAt(
      tx,
      product,
      qualityTargets.flatMap((row) => (row.productId ? [row.productId] : [])),
    );
    await touchUpdatedAt(
      tx,
      purchase,
      qualityTargets.flatMap((row) => (row.purchaseId ? [row.purchaseId] : [])),
    );

    const purchases =
      affectedPurchaseDbIds.length === 0
        ? []
        : await tx.query.purchase.findMany({
            where: {
              RAW: (table: PgTable) =>
                relationalSql(
                  table,
                  and(
                    inArray(purchase.id, affectedPurchaseDbIds),
                    notDeleted(purchase),
                  ),
                ),
            },
            columns: { id: true, shortcode: true },
          });
    const liveExpensePurchaseIds =
      affectedPurchaseDbIds.length === 0
        ? []
        : await tx.query.expense.findMany({
            where: {
              RAW: (table: PgTable) =>
                relationalSql(
                  table,
                  and(
                    inArray(expense.purchaseId, affectedPurchaseDbIds),
                    notDeleted(expense),
                  ),
                ),
            },
            columns: { purchaseId: true },
          });
    const purchasesWithLiveExpenses = new Set(
      liveExpensePurchaseIds
        .map((row) => row.purchaseId)
        .filter((value): value is PurchaseId => value !== null),
    );
    const purchaseShortcodes = new Map(
      purchases.map((row) => [row.id, row.shortcode]),
    );
    const affectedPurchaseIds = affectedPurchaseDbIds.flatMap((id) => {
      const shortcode = purchaseShortcodes.get(id);
      return shortcode ? [parseShortcodeFor("purchase", shortcode)] : [];
    });
    const newlyEmptyPurchaseIds = affectedPurchaseDbIds.flatMap((id) => {
      const shortcode = purchaseShortcodes.get(id);
      return shortcode && !purchasesWithLiveExpenses.has(id)
        ? [parseShortcodeFor("purchase", shortcode)]
        : [];
    });

    return {
      priceAffectedProductIds: await syncChangedEffectivePrices(
        tx,
        pricesBefore,
      ),
      result: {
        deleted,
        deletedIds: qualityTargets.map((row) =>
          parseShortcodeFor("expense", row.shortcode),
        ),
        affectedPurchaseIds,
        newlyEmptyPurchaseIds,
      },
    };
  });

export const deleteExpenses = async (
  db: Database,
  shortcodes: ExpenseShortcode[],
  actor: ActorContext,
): Promise<ProductId[]> =>
  (await deleteExpensesWithPurchaseEffects(db, shortcodes, actor))
    .priceAffectedProductIds;
