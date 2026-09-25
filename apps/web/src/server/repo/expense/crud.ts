import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  EXPENSE_DATE_REQUIRED_MESSAGE,
  hasValidExpenseDate,
} from "@cubby/schemas/expense-fields";
import { inferExpenseLineKind } from "@cubby/schemas/expense-line-kind";
import type {
  ExpenseId,
  ExpenseShortcode,
  ProductId,
  ProductShortcode,
  ProjectId,
  ProjectShortcode,
  PurchaseId,
  PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  DeleteExpensesWithPurchaseEffectsOut,
  ExpenseBulkCostTypeInput,
  ExpenseBulkTradeInput,
  ExpenseCreateInput,
  ExpenseOut,
  ExpenseUpdateInput,
} from "@cubby/schemas/project";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  expense,
  expenseAttribution,
  ledgerSourceClaim,
  purchase,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  loadDataQualities,
  touchDataQualityTargets,
} from "~/server/repo/data-quality";
import {
  buildPartialUpdateValues,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityCrud } from "~/server/repo/entity-crud-factory";
import { bulkPatchEntities, patchEntityRows } from "~/server/repo/entity-patch";
import { replaceExpenseAttributionRole } from "~/server/repo/expense-attribution";
import {
  assertExplicitSourceClaimsForAmountChange,
  replaceLedgerSourceClaims,
} from "~/server/repo/ledger-source-claim";
import {
  pricingProductIds,
  syncChangedEffectivePrices,
} from "~/server/repo/product/price-sync";
import { loadEffectiveProductPricesById } from "~/server/repo/product/pricing";
import {
  findOrCreatePurchase,
  foldChargeInto,
  renameChargeOrderId,
} from "~/server/repo/purchase";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";

import {
  expenseInheritanceReadExtras,
  validateExpenseInheritance,
} from "../expense-inheritance";
import { loadExpenseProjectAllocations } from "../expense-project-allocation";
import {
  assertQuantitySignMatchesCost,
  dbExpenseToAPI,
  type ExpenseRow,
} from "./helpers";

export const EXPENSE_DELETE_EDGE_POLICY = {
  "ExpenseAttribution.expenseId": {
    code: "soft-delete-attributions",
    effect: "soft-delete",
    description:
      "Deleting an Expense removes its unitless beneficiary and initial-funder shares; no money exists on those child rows.",
  },
  "LedgerSourceClaim.expenseId": {
    code: "soft-delete-source-references",
    effect: "soft-delete",
    description:
      "Deleting an Expense retires the normalized import references that identify that ledger row.",
  },
} as const satisfies IncomingEdgePolicy<"expense", OperationDisposition>;

type ExpenseUpdateData = ExpenseUpdateInput["data"];

const assertExpenseDate = (cost: number | null, date: string | null) => {
  if (!hasValidExpenseDate({ cost, date })) {
    throw createAppError("CONSTRAINT_VIOLATION", EXPENSE_DATE_REQUIRED_MESSAGE);
  }
};

type ResolvedExpenseUpdate = Omit<
  ExpenseUpdateData,
  | "vendor"
  | "orderId"
  | "projectId"
  | "productId"
  | "purchaseId"
  | "beneficiaries"
  | "funders"
  | "sourceClaims"
> & {
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

/**
 * Resolve a bulk selection to live uuids, DROPPING codes that name nothing
 * live. Bulk writes here are documented to skip a soft-deleted or unknown id
 * rather than reject the whole batch — the alternative makes a selection that
 * merely raced a delete fail entirely, and callers pass sets they didn't
 * individually verify. A throwing variant would belong on single-row paths,
 * where "not found" is the caller's own mistake.
 */
const resolveLiveExpenseIds = (
  tx: DrizzleTransaction,
  shortcodes: ExpenseShortcode[],
): Promise<ExpenseId[]> => resolveAllPresent(tx, "expense", shortcodes);

type ExpenseBulkPatch = Pick<
  ExpenseUpdateData,
  "projectId" | "trade" | "costType" | "date"
>;

export const updateExpensesInBulk = (
  db: Database,
  shortcodes: ExpenseShortcode[],
  data: ExpenseBulkPatch,
  actor: ActorContext,
) =>
  bulkPatchEntities(
    db,
    actor,
    {
      entity: "expense",
      table: expense,
      values: async (tx) => ({
        projectId:
          data.projectId == null
            ? data.projectId
            : await resolveLiveProjectId(tx, data.projectId),
        trade: data.trade,
        costType: data.costType,
        date: data.date,
      }),
      validate: async (tx, before, values) => {
        for (const row of before) {
          const next = { ...row, ...values };
          assertExpenseDate(next.cost, next.date);
          await validateExpenseInheritance(tx, next);
        }
      },
    },
    shortcodes,
    data,
  );

const fetchExpenseById = (
  db: Database | DrizzleTransaction,
  id: ExpenseId,
): Promise<ExpenseRow | undefined> =>
  (async () => {
    const row = await unwrapDb(db).query.expense.findFirst({
      where: and(eq(expense.id, id), notDeleted(expense)),
      extras: expenseInheritanceReadExtras(),
      ...relations.expense.withProject,
    });
    if (!row) return undefined;
    return {
      ...row,
      projectAllocations: await loadExpenseProjectAllocations(db, [id]),
    };
  })();

const expenseCrud = createEntityCrud({
  table: expense,
  entity: "expense",
  fetchById: fetchExpenseById,
  fromDB: async (db, row) => {
    const dataQualities = await loadDataQualities(db, "expense", [row.id]);
    // SAFETY: `row` was just fetched live by id, so its quality was evaluated.
    return dbExpenseToAPI(row, dataQualities.get(row.id)!);
  },
  toUpdate: (data: ResolvedExpenseUpdate) =>
    buildPartialUpdateValues({
      name: data.name,
      cost: data.cost,
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
    }),
  auditUpdateFields: [...entityFieldModels.expense.audit],
});

export const getExpenseByID = expenseCrud.getByID;
export const getExpenseByShortcode = expenseCrud.getByShortcode;

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
  productQuantity: number | null;
  cost: number | null;
}) => {
  if (input.lineKind !== "principal" && input.productId !== null) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Only principal Expenses may link a Product. For a disposal or write-off, use lineKind=principal, cost=0, and a negative productQuantity; use other_adjustment only for purchase-level amounts with no Product.",
    );
  }
  if (input.lineBasis === "allocation" && input.productId !== null) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "An allocation Expense may not link a Product — the money is a slice of an un-itemized total, so it buys no particular item.",
    );
  }
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
export const updateExpense = async (
  db: Database,
  shortcode: ExpenseShortcode,
  data: ExpenseUpdateData,
  actor: ActorContext,
): Promise<{
  output: ExpenseOut;
  entityId: ExpenseId;
  priceAffectedProductIds: ProductId[];
}> => {
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
  ].some((value) => value !== undefined);
  const qualityCanChange = [
    data.cost,
    data.future,
    data.productId,
    data.purchaseId,
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
      ? await getExpenseByID(tx, id)
      : undefined;
    const qualityBefore = await tx.query.expense.findFirst({
      where: and(eq(expense.id, id), notDeleted(expense)),
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
        trade: true,
      },
    });
    const nextCost =
      data.cost === undefined ? (qualityBefore?.cost ?? null) : data.cost;
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

  // Reclassifying a principal line as an adjustment drops its project: an
  // adjustment cannot store one (`validateExpenseInheritance` rejects it),
  // and every editing surface — list, embedded relation table, detail —
  // relies on the server owning that rule rather than each sending
  // `projectId: null` alongside.
  const dropProjectOnReclassify = (update: ResolvedExpenseUpdate) => {
    if (
      update.lineKind !== undefined &&
      update.lineKind !== "principal" &&
      update.projectId === undefined
    ) {
      update.projectId = null;
    }
  };

  const validateUpdateState = async (
    tx: DrizzleTransaction,
    state: UpdateState,
    update: ResolvedExpenseUpdate,
    resultingPurchaseId: PurchaseId | null,
  ) => {
    const previous = state.qualityBefore;
    dropProjectOnReclassify(update);
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
      lineKind: update.lineKind ?? state.qualityBefore?.lineKind ?? "principal",
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
    const explicitPurchaseId = await resolveOptionalPurchaseId(tx, purchaseId);
    const resultingProductId =
      resolvedProductId === undefined
        ? (state.qualityBefore?.productId ?? null)
        : resolvedProductId;
    assertExpenseProductLink({
      productId: resultingProductId,
      lineKind: data.lineKind ?? state.qualityBefore?.lineKind ?? "principal",
      lineBasis:
        data.lineBasis ?? state.qualityBefore?.lineBasis ?? "item_line",
      productQuantity:
        data.productQuantity === undefined
          ? (state.qualityBefore?.productQuantity ?? null)
          : data.productQuantity,
      cost: state.nextCost,
    });
    const update: ResolvedExpenseUpdate = { ...restColumns };
    if (resolvedProductId === null && data.productQuantity === undefined) {
      update.productQuantity = null;
    }
    if (resolvedProjectId !== undefined) update.projectId = resolvedProjectId;
    if (resolvedProductId !== undefined) update.productId = resolvedProductId;
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
      );
    }
    if (funders !== undefined) {
      await replaceExpenseAttributionRole(
        tx,
        state.id,
        "funder",
        funders ?? [],
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
    output: ExpenseOut,
  ) => {
    if (!state.nestedBefore) return;
    const changes = computeChanges(state.nestedBefore, output, [
      "beneficiaries",
      "funders",
      "sourceClaims",
    ]);
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "expense",
        entityId: state.id,
        action: "update",
        changes,
      });
    }
  };

  const currentCharge = async (tx: DrizzleTransaction, state: UpdateState) => {
    const existing = await tx.query.expense.findFirst({
      where: and(eq(expense.id, state.id), notDeleted(expense)),
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
    const state = await loadUpdateState(tx);
    const {
      explicitPurchaseId,
      resolvedProductId,
      resultingProductId,
      update: rest,
    } = await resolveUpdateColumns(tx, state);

    const priceCandidates = priceCanChange
      ? pricingProductIds([state.qualityBefore?.productId, resultingProductId])
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
      const output = await expenseCrud.update(tx, state.id, update, actor);
      await auditNestedChanges(tx, state, output);
      if (qualityCanChange) {
        await touchDataQualityTargets(tx, {
          productIds: [
            state.qualityBefore?.productId,
            resolvedProductId,
          ].filter(
            (value): value is ProductId =>
              value !== null && value !== undefined,
          ),
          purchaseIds: [
            state.qualityBefore?.purchaseId,
            explicitPurchaseId,
          ].filter(
            (value): value is PurchaseId =>
              value !== null && value !== undefined,
          ),
        });
      }
      return {
        output,
        entityId: state.id,
        priceAffectedProductIds: await syncChangedEffectivePrices(
          tx,
          pricesBefore,
        ),
      };
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
    const output = await expenseCrud.update(tx, state.id, update, actor);
    await auditNestedChanges(tx, state, output);
    await touchDataQualityTargets(tx, {
      productIds: [state.qualityBefore?.productId, resolvedProductId].filter(
        (value): value is ProductId => value !== null && value !== undefined,
      ),
      purchaseIds: [state.qualityBefore?.purchaseId, resolved].filter(
        (value): value is PurchaseId => value !== null && value !== undefined,
      ),
    });
    return {
      output,
      entityId: state.id,
      priceAffectedProductIds: await syncChangedEffectivePrices(
        tx,
        pricesBefore,
      ),
    };
  });
};

const getExpensesByIDs = async (
  db: Database,
  ids: ExpenseId[],
): Promise<ExpenseOut[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.expense.findMany({
    where: and(inArray(expense.id, ids), notDeleted(expense)),
    extras: expenseInheritanceReadExtras(),
    ...relations.expense.withProject,
  });
  const [allocations, dataQualities] = await Promise.all([
    loadExpenseProjectAllocations(db, ids),
    loadDataQualities(db, "expense", ids),
  ]);
  const byExpense = new Map<ExpenseId, typeof allocations>();
  for (const allocation of allocations) {
    const existing = byExpense.get(allocation.expenseId) ?? [];
    existing.push(allocation);
    byExpense.set(allocation.expenseId, existing);
  }
  return rows.map((row) =>
    dbExpenseToAPI(
      {
        ...row,
        projectAllocations: byExpense.get(row.id) ?? [],
      },
      // SAFETY: `row` came from `rows`, which `dataQualities` was loaded for.
      dataQualities.get(row.id)!,
    ),
  );
};

export const createExpense = async (
  db: Database,
  data: ExpenseCreateInput,
  actor: ActorContext,
): Promise<{
  output: ExpenseOut;
  entityId: ExpenseId;
  priceAffectedProductIds: ProductId[];
}> => {
  const result = await withTransaction(db, async (tx) => {
    // Same transaction as the insert: a vendor or charge created here must not
    // outlive a failed expense write.
    // A caller-supplied `purchaseId` skips `resolveCharge` entirely, so this is
    // the only place it gets checked for liveness — resolving THROUGH
    // `resolveLivePurchaseId` (live-only) folds in what `assertPurchaseLive`
    // used to check separately (an FK proves the row exists, not that it
    // isn't tombstoned).
    const explicitPurchaseId = data.purchaseId
      ? await resolveLivePurchaseId(tx, data.purchaseId)
      : null;
    const purchaseId =
      explicitPurchaseId ?? (await resolveCharge(tx, actor, data)) ?? null;

    const explicitProjectId = data.projectId
      ? await resolveLiveProjectId(tx, data.projectId)
      : null;
    const productId = data.productId
      ? await resolveLiveProductId(tx, data.productId)
      : null;
    const projectId = explicitProjectId;
    const lineKind =
      data.lineKind ?? inferExpenseLineKind({ name: data.name, productId });
    if (lineKind !== "principal" && productId !== null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Only principal Expenses may link a Product. For a disposal or write-off, use lineKind=principal, cost=0, and a negative productQuantity; use other_adjustment only for purchase-level amounts with no Product.",
      );
    }
    if (data.lineBasis === "allocation" && productId !== null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "An allocation Expense may not link a Product — the money is a slice of an un-itemized total, so it buys no particular item.",
      );
    }
    if (data.productQuantity !== null && productId === null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Product quantity requires a linked product.",
      );
    }
    assertExpenseDate(data.cost, data.date);
    assertQuantitySignMatchesCost(data.cost, data.productQuantity);
    await validateExpenseInheritance(tx, {
      lineKind,
      projectId,
      productId,
      purchaseId,
      trade: data.trade,
    });
    const pricesBefore = await loadEffectiveProductPricesById(
      tx,
      pricingProductIds([productId]),
    );

    const created = await insertWithShortcode(tx, "expense", {
      name: data.name,
      cost: data.cost,
      date: data.date,
      lineKind,
      lineBasis: data.lineBasis,
      costType: data.costType,
      trade: data.trade,
      url: data.url,
      notes: data.notes,
      future: data.future,
      projectId,
      productId,
      productQuantity: data.productQuantity,
      purchaseId,
    });
    await replaceExpenseAttributionRole(
      tx,
      created.id,
      "beneficiary",
      data.beneficiaries ?? [],
    );
    await replaceExpenseAttributionRole(
      tx,
      created.id,
      "funder",
      data.funders ?? [],
    );
    await replaceLedgerSourceClaims(
      tx,
      {
        expenseId: created.id,
        targetAmount: data.cost,
      },
      data.sourceClaims ?? [],
    );
    await logAuditEntry(tx, actor, {
      entityType: "expense",
      entityId: created.id,
      action: "create",
    });
    await touchDataQualityTargets(tx, {
      productIds: productId ? [productId] : [],
      purchaseIds: purchaseId ? [purchaseId] : [],
    });
    return {
      id: created.id,
      priceAffectedProductIds: await syncChangedEffectivePrices(
        tx,
        pricesBefore,
      ),
    };
  });
  return {
    output: await getExpenseByID(db, result.id),
    entityId: result.id,
    priceAffectedProductIds: result.priceAffectedProductIds,
  };
};

export const setExpensesTrade = async (
  db: Database,
  input: ExpenseBulkTradeInput,
  actor: ActorContext,
): Promise<ExpenseOut[]> => {
  const { trade } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const ids = await resolveLiveExpenseIds(tx, input.ids);
    if (ids.length === 0) return [];

    const rows = await tx.query.expense.findMany({
      where: and(inArray(expense.id, ids), notDeleted(expense)),
      columns: {
        lineKind: true,
        projectId: true,
        productId: true,
        purchaseId: true,
      },
    });
    for (const row of rows) {
      await validateExpenseInheritance(tx, { ...row, trade });
    }

    await patchEntityRows(
      tx,
      actor,
      {
        entity: "expense",
        table: expense,
        fields: entityFieldModels.expense.bulk,
      },
      ids,
      { trade },
    );
    // Preserve the convenience setter's all-live-selection result even when
    // patchEntityRows finds no changed rows.
    return ids;
  });

  return getExpensesByIDs(db, updatedIds);
};

export const setExpensesCostType = async (
  db: Database,
  input: ExpenseBulkCostTypeInput,
  actor: ActorContext,
): Promise<ExpenseOut[]> => {
  const { costType } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const ids = await resolveLiveExpenseIds(tx, input.ids);
    if (ids.length === 0) return [];

    await patchEntityRows(
      tx,
      actor,
      {
        entity: "expense",
        table: expense,
        fields: entityFieldModels.expense.bulk,
      },
      ids,
      { costType },
    );
    // Preserve the convenience setter's all-live-selection result even when
    // patchEntityRows finds no changed rows.
    return ids;
  });

  return getExpensesByIDs(db, updatedIds);
};

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
    const ids = await resolveAllOrThrow(tx, "expense", shortcodes);
    await lockAndValidateForDelete(tx, expense, ids, "Expense");

    const qualityTargets = await tx.query.expense.findMany({
      where: and(inArray(expense.id, ids), notDeleted(expense)),
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

    const { deleted } = await removeEntity(tx, {
      entity: "expense",
      ids,
      removal: "soft",
      actor,
      children: [
        {
          table: expenseAttribution,
          parentColumns: [expenseAttribution.expenseId],
          auditKey: "cascadedExpenseAttributions",
        },
        {
          table: ledgerSourceClaim,
          parentColumns: [ledgerSourceClaim.expenseId],
          auditKey: "cascadedLedgerSourceClaims",
        },
      ],
    });

    await touchDataQualityTargets(tx, {
      productIds: qualityTargets
        .map((row) => row.productId)
        .filter((value): value is ProductId => value !== null),
      purchaseIds: qualityTargets
        .map((row) => row.purchaseId)
        .filter((value): value is PurchaseId => value !== null),
    });

    const purchases =
      affectedPurchaseDbIds.length === 0
        ? []
        : await tx.query.purchase.findMany({
            where: and(
              inArray(purchase.id, affectedPurchaseDbIds),
              notDeleted(purchase),
            ),
            columns: { id: true, shortcode: true },
          });
    const liveExpensePurchaseIds =
      affectedPurchaseDbIds.length === 0
        ? []
        : await tx.query.expense.findMany({
            where: and(
              inArray(expense.purchaseId, affectedPurchaseDbIds),
              notDeleted(expense),
            ),
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
};

export const deleteExpenses = async (
  db: Database,
  shortcodes: ExpenseShortcode[],
  actor: ActorContext,
): Promise<ProductId[]> =>
  (await deleteExpensesWithPurchaseEffects(db, shortcodes, actor))
    .priceAffectedProductIds;
