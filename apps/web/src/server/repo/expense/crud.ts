import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
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
import {
  unsafeExpenseShortcode,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import type {
  DeleteExpensesWithPurchaseEffectsOut,
  ExpenseBulkCostTypeInput,
  ExpenseBulkMoveInput,
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
import {
  type AuditEntryInput,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import { touchDataQualityTargets } from "~/server/repo/data-quality";
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
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { findOrCreateVendor } from "~/server/repo/vendor";
import {
  assertQuantitySignMatchesCost,
  dbExpenseToAPI,
  type ExpenseRow,
  resolveDefaultProjectId,
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

const fetchExpenseById = (
  db: Database | DrizzleTransaction,
  id: ExpenseId,
): Promise<ExpenseRow | undefined> =>
  unwrapDb(db).query.expense.findFirst({
    where: and(eq(expense.id, id), notDeleted(expense)),
    ...relations.expense.withProject,
  });

const expenseCrud = createEntityCrud({
  table: expense,
  entity: "expense",
  fetchById: fetchExpenseById,
  fromDB: (_db, row) => dbExpenseToAPI(row),
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
  auditUpdateFields: [
    "name",
    "cost",
    "date",
    "lineKind",
    "lineBasis",
    "costType",
    "trade",
    "url",
    "notes",
    "future",
    "projectId",
    "productId",
    "productQuantity",
    "purchaseId",
  ],
});

export const getExpenseByID = expenseCrud.getByID;
export const getExpenseByShortcode = expenseCrud.getByShortcode;

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
  current?: {
    purchaseId: PurchaseId | null;
    vendorName: string | null;
    orderId: string | null;
    lineCount: number;
  },
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
  const vendorName = data.vendor?.trim() || current?.vendorName || undefined;
  if (!vendorName) return undefined;

  const requestedOrderId = data.orderId?.trim() || null;
  const sameVendor = current?.vendorName === vendorName;

  if (
    current?.purchaseId &&
    sameVendor &&
    (data.orderId === undefined || current.orderId === requestedOrderId)
  ) {
    return undefined;
  }

  if (
    current?.purchaseId &&
    sameVendor &&
    current.lineCount <= 1 &&
    data.orderId !== undefined
  ) {
    const renamed = await renameChargeOrderId(
      tx,
      current.purchaseId,
      requestedOrderId,
      actor,
    );
    if (renamed) return undefined;
  }

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

  if (
    current?.purchaseId &&
    current.purchaseId !== target &&
    current.lineCount <= 1
  ) {
    await foldChargeInto(tx, current.purchaseId, target, actor);
  }

  return target;
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

  return withTransaction(db, async (tx) => {
    const id = await resolveOrThrow(tx, "expense", shortcode);
    const [lockedExpense] = await tx
      .select({ id: expense.id })
      .from(expense)
      .where(and(eq(expense.id, id), notDeleted(expense)))
      .for("update")
      .limit(1);
    if (!lockedExpense)
      throw createAppError(
        "EXPENSE_NOT_FOUND",
        `Expense not found: ${shortcode}`,
      );
    const nestedBefore =
      beneficiaries !== undefined ||
      funders !== undefined ||
      sourceClaims !== undefined
        ? await getExpenseByID(tx, id)
        : undefined;
    const auditNestedChanges = async (output: ExpenseOut) => {
      if (!nestedBefore) return;
      const changes = computeChanges(nestedBefore, output, [
        "beneficiaries",
        "funders",
        "sourceClaims",
      ]);
      if (changes)
        await logAuditEntry(tx, actor, {
          entityType: "expense",
          entityId: id,
          action: "update",
          changes,
        });
    };
    const beforeQualityTargets = await tx.query.expense.findFirst({
      where: and(eq(expense.id, id), notDeleted(expense)),
      columns: {
        cost: true,
        productId: true,
        productQuantity: true,
        purchaseId: true,
        lineKind: true,
        lineBasis: true,
      },
    });
    await assertExplicitSourceClaimsForAmountChange(
      tx,
      { expenseId: id },
      beforeQualityTargets?.cost ?? null,
      data.cost === undefined
        ? (beforeQualityTargets?.cost ?? null)
        : data.cost,
      sourceClaims,
    );

    const resolvedProjectId =
      projectId === undefined
        ? undefined
        : projectId === null
          ? null
          : await resolveLiveProjectId(tx, projectId);

    const resolvedProductId =
      productId === undefined
        ? undefined
        : productId === null
          ? null
          : await resolveLiveProductId(tx, productId);

    const resultingProductId =
      resolvedProductId === undefined
        ? (beforeQualityTargets?.productId ?? null)
        : resolvedProductId;
    const resultingLineKind =
      data.lineKind ?? beforeQualityTargets?.lineKind ?? "principal";
    if (resultingLineKind !== "principal" && resultingProductId !== null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Only principal Expenses may link a Product.",
      );
    }
    const resultingLineBasis =
      data.lineBasis ?? beforeQualityTargets?.lineBasis ?? "item_line";
    if (resultingLineBasis === "allocation" && resultingProductId !== null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "An allocation Expense may not link a Product — the money is a slice of an un-itemized total, so it buys no particular item.",
      );
    }
    if (data.productQuantity != null && resultingProductId === null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Product quantity requires a linked product.",
      );
    }
    assertQuantitySignMatchesCost(
      data.cost === undefined
        ? (beforeQualityTargets?.cost ?? null)
        : data.cost,
      data.productQuantity === undefined
        ? (beforeQualityTargets?.productQuantity ?? null)
        : data.productQuantity,
    );

    const explicitPurchaseId =
      purchaseId === undefined
        ? undefined
        : purchaseId === null
          ? null
          : await resolveLivePurchaseId(tx, purchaseId);

    const rest: ResolvedExpenseUpdate = {
      ...restColumns,
      ...(resolvedProductId === null && data.productQuantity === undefined
        ? { productQuantity: null }
        : {}),
      ...(resolvedProjectId !== undefined
        ? { projectId: resolvedProjectId }
        : {}),
      ...(resolvedProductId !== undefined
        ? { productId: resolvedProductId }
        : {}),
    };

    const applyNested = async () => {
      if (beneficiaries !== undefined)
        await replaceExpenseAttributionRole(
          tx,
          id,
          "beneficiary",
          beneficiaries ?? [],
        );
      if (funders !== undefined)
        await replaceExpenseAttributionRole(tx, id, "funder", funders ?? []);
      if (sourceClaims !== undefined)
        await replaceLedgerSourceClaims(
          tx,
          {
            expenseId: id,
            targetAmount:
              data.cost === undefined
                ? (beforeQualityTargets?.cost ?? null)
                : data.cost,
          },
          sourceClaims ?? [],
        );
    };

    const priceCanChange =
      data.cost !== undefined ||
      data.future !== undefined ||
      data.productId !== undefined ||
      data.productQuantity !== undefined;
    const priceCandidates = priceCanChange
      ? pricingProductIds([beforeQualityTargets?.productId, resultingProductId])
      : [];
    const pricesBefore = await loadEffectiveProductPricesById(
      tx,
      priceCandidates,
    );

    if (!needsResolve) {
      await applyNested();
      const output = await expenseCrud.update(
        tx,
        id,
        {
          ...rest,
          ...(explicitPurchaseId !== undefined
            ? { purchaseId: explicitPurchaseId }
            : {}),
        },
        actor,
      );
      await auditNestedChanges(output);
      if (
        data.cost !== undefined ||
        data.productId !== undefined ||
        data.purchaseId !== undefined
      ) {
        await touchDataQualityTargets(tx, {
          productIds: [
            beforeQualityTargets?.productId,
            resolvedProductId,
          ].filter(
            (value): value is ProductId =>
              value !== null && value !== undefined,
          ),
          purchaseIds: [
            beforeQualityTargets?.purchaseId,
            explicitPurchaseId,
          ].filter(
            (value): value is PurchaseId =>
              value !== null && value !== undefined,
          ),
        });
      }
      return {
        output,
        entityId: id,
        priceAffectedProductIds: await syncChangedEffectivePrices(
          tx,
          pricesBefore,
        ),
      };
    }

    const existing = await tx.query.expense.findFirst({
      where: and(eq(expense.id, id), notDeleted(expense)),
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

    // How many live lines the current charge has, which decides whether an
    // order-id correction renames the charge in place or reassigns this line to a
    // different one. Only asked when there IS a charge.
    //
    // Counted on `tx`, not on `db`: a read on the outer handle is a DIFFERENT
    // connection, so it can't see this transaction's own writes and — under the
    // per-request `pg.Pool` (max 5) — competes with it for a connection. The
    // decision this count drives then races the very rows it's counting.
    const lineCount = live
      ? ((
          await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(expense)
            .where(and(eq(expense.purchaseId, live.id), notDeleted(expense)))
        )[0]?.n ?? 0)
      : 0;

    const resolved = await resolveCharge(
      tx,
      actor,
      {
        ...data,
        date: data.date === undefined ? existing?.date : data.date,
      },
      {
        purchaseId: live ? (existing?.purchaseId ?? null) : null,
        vendorName:
          live?.vendor && live.vendor.deletedAt === null
            ? live.vendor.name
            : null,
        orderId: live?.orderId ?? null,
        lineCount,
      },
    );

    await applyNested();

    const output = await expenseCrud.update(
      tx,
      id,
      {
        ...rest,
        ...(resolved === undefined ? {} : { purchaseId: resolved }),
      },
      actor,
    );
    await auditNestedChanges(output);
    await touchDataQualityTargets(tx, {
      productIds: [beforeQualityTargets?.productId, resolvedProductId].filter(
        (value): value is ProductId => value !== null && value !== undefined,
      ),
      purchaseIds: [beforeQualityTargets?.purchaseId, resolved].filter(
        (value): value is PurchaseId => value !== null && value !== undefined,
      ),
    });
    return {
      output,
      entityId: id,
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
    ...relations.expense.withProject,
  });
  return rows.map(dbExpenseToAPI);
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
    const projectId = await resolveDefaultProjectId(tx, {
      projectId: explicitProjectId,
      productId,
    });
    const lineKind =
      data.lineKind ?? inferExpenseLineKind({ name: data.name, productId });
    if (lineKind !== "principal" && productId !== null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Only principal Expenses may link a Product.",
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
    assertQuantitySignMatchesCost(data.cost, data.productQuantity);
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

export const moveExpenses = async (
  db: Database,
  input: ExpenseBulkMoveInput,
  actor: ActorContext,
): Promise<ExpenseOut[]> => {
  const updatedIds = await withTransaction(db, async (tx) => {
    const projectId =
      input.projectId !== null
        ? await resolveLiveProjectId(tx, input.projectId)
        : null;

    const ids = await resolveLiveExpenseIds(tx, input.ids);

    const before = await tx.query.expense.findMany({
      where: and(inArray(expense.id, ids), notDeleted(expense)),
      columns: { id: true, projectId: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(expense)
      .set({ projectId })
      .where(and(inArray(expense.id, ids), notDeleted(expense)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, projectId }, [
        "projectId",
      ]);
      if (changes) {
        auditEntries.push({
          entityType: "expense",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
  });

  return getExpensesByIDs(db, updatedIds);
};

export const setExpensesTrade = async (
  db: Database,
  input: ExpenseBulkTradeInput,
  actor: ActorContext,
): Promise<ExpenseOut[]> => {
  const { trade } = input;

  const updatedIds = await withTransaction(db, async (tx) => {
    const ids = await resolveLiveExpenseIds(tx, input.ids);
    const before = await tx.query.expense.findMany({
      where: and(inArray(expense.id, ids), notDeleted(expense)),
      columns: { id: true, trade: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(expense)
      .set({ trade })
      .where(and(inArray(expense.id, ids), notDeleted(expense)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, trade }, ["trade"]);
      if (changes) {
        auditEntries.push({
          entityType: "expense",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
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
    const before = await tx.query.expense.findMany({
      where: and(inArray(expense.id, ids), notDeleted(expense)),
      columns: { id: true, costType: true },
    });
    if (before.length === 0) return [];

    await tx
      .update(expense)
      .set({ costType })
      .where(and(inArray(expense.id, ids), notDeleted(expense)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { id: row.id, costType }, [
        "costType",
      ]);
      if (changes) {
        auditEntries.push({
          entityType: "expense",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return before.map((row) => row.id);
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
    const ids = await resolveLiveExpenseIds(tx, shortcodes);
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
      return shortcode ? [unsafePurchaseShortcode(shortcode)] : [];
    });
    const newlyEmptyPurchaseIds = affectedPurchaseDbIds.flatMap((id) => {
      const shortcode = purchaseShortcodes.get(id);
      return shortcode && !purchasesWithLiveExpenses.has(id)
        ? [unsafePurchaseShortcode(shortcode)]
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
          unsafeExpenseShortcode(row.shortcode),
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
