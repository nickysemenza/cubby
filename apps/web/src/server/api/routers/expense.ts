/**
 * Expense Router — project spend ledger (migrated from Notion).
 * Pure crud-factory shape; no children, no rollups of its own.
 */

import {
  type ExpenseShortcode,
  expenseShortcode,
  purchaseShortcode,
  unsafeExpenseId,
  unsafePurchaseId,
  vendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  expenseAnalyticsOut,
  expenseBulkCostTypeInput,
  expenseBulkMoveInput,
  expenseBulkTradeInput,
  expenseCreateInput,
  expenseFiltersSchema,
  expenseListAndSideEffectsOut,
  expenseMatchInput,
  expenseMatchOut,
  expenseOut,
  expenseSortableFields,
  expenseTradeAffinityOut,
  expenseUpdateData,
  plainDate,
} from "@cubby/schemas/project";
import { vendorOptionsOut } from "@cubby/schemas/vendor";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import {
  createExpense,
  deleteExpenses,
  expenseAnalytics,
  expenseList,
  expenseTradeAffinity,
  getExpenseByID,
  getExpenseByShortcode,
  matchExpenses,
  moveExpenses,
  setExpensesCostType,
  setExpensesTrade,
  updateExpense,
} from "~/server/repo/expense";
import {
  getPurchaseExpenses,
  getPurchaseLinkIdentityByID,
} from "~/server/repo/purchase";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { vendorOptions as loadVendorOptions } from "~/server/repo/vendor";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const {
  getByID,
  getByShortcode,
  list,
  create,
  update,
  delete: deleteItem,
} = createSearchableEntityCrudProcedures({
  schemas: {
    createInput: expenseCreateInput,
    updateInput: expenseUpdateData,
    output: expenseOut,
    filters: expenseFiltersSchema,
    sort: {
      sortableFields: expenseSortableFields,
      defaultSort: "date",
      // No grouping on this table; an empty roster keeps the new joined-name
      // sort keys from being accepted as group keys that do nothing.
      groupableFields: ["costType"] as const,
    },
    idSchema: expenseShortcode,
  },
  repository: {
    getByID: async (services, shortcode: ExpenseShortcode) => {
      const id = await resolveLiveShortcode(services.db, shortcode, "expense");
      if (!id) {
        throw createAppError(
          "EXPENSE_NOT_FOUND",
          `Expense not found: ${shortcode}`,
        );
      }
      return getExpenseByID(services.db, unsafeExpenseId(id));
    },
    getByShortcode: (services, shortcode) =>
      getExpenseByShortcode(services.db, shortcode),
    list: async (services, filters, sort, pagination) =>
      expenseList(services.db, filters, sort, pagination),
    // The repo hands back the uuid alongside the output, so neither of these
    // re-resolves a code it just had.
    create: async (services, data) =>
      await createExpense(services.db, data, services.actorContext),
    update: async (services, shortcode: ExpenseShortcode, data) =>
      await updateExpense(services.db, shortcode, data, services.actorContext),
    delete: async (services, ids: ExpenseShortcode[]) => {
      await deleteExpenses(services.db, ids, services.actorContext);
      return undefined;
    },
  },
  entityName: "expense",
});

/**
 * Batch-resolve the shortcodes a bulk-write result carries into the internal
 * uuids `runMutationSideEffectsForEntities` keys on — one query for the
 * whole batch, not one per row.
 */
async function expenseEntityIds(
  db: Parameters<typeof resolveLiveShortcodes>[0],
  ids: ExpenseShortcode[],
) {
  const resolved = await resolveLiveShortcodes(db, ids, "expense");
  return ids.flatMap((code) => {
    const uuid = resolved.get(code);
    return uuid ? [unsafeExpenseId(uuid)] : [];
  });
}

/**
 * Every expense matching the filters, in one round trip — chart aggregates
 * happen client-side, and `list`'s 500-row page cap would silently truncate
 * them (same fetch-all convention as project.dashboard).
 */
const FETCH_ALL = { pageIndex: 0, pageSize: 100_000 };
const chartData = protectedProcedure
  .input(expenseFiltersSchema)
  .output(strictOutput(z.array(expenseOut)))
  .query(async ({ ctx, input }) => {
    const { data } = await expenseList(
      ctx.db,
      input,
      [{ orderBy: "date", direction: "asc" }],
      FETCH_ALL,
    );
    return data;
  });

/**
 * Server-side chart aggregates — grouped SQL sums/counts over the SAME
 * filter shape as `list`/`chartData`, replacing the client-side grouping
 * that ran over `chartData`'s fetch-all. See repo/expense/analytics.ts for
 * the SQL; `chartData` stays in place for whatever else still fetches raw rows.
 */
const analytics = protectedProcedure
  .input(expenseFiltersSchema)
  .output(strictOutput(expenseAnalyticsOut))
  .query(({ ctx, input }) => expenseAnalytics(ctx.db, input));

/**
 * Vendor roster for the ledger's Vendor filter picklist. Kept on THIS router
 * (rather than moving to `vendor.options`) so the ledger's filter wiring didn't
 * have to change alongside everything else; it's a thin re-export of
 * `repo/vendor.ts`'s query, which is the single source of truth.
 */
const vendorOptions = protectedProcedure
  .output(strictOutput(vendorOptionsOut))
  .query(({ ctx }) => loadVendorOptions(ctx.db));

/**
 * The canonical identity and other lines of this expense's charge — the "this
 * charge" detail section that replaced #475's "Same Order".
 *
 * Shows whenever a charge exists, not only when there's an order id: 33% of
 * vendor-bearing rows have none, and those rows still belong to a real
 * transaction. Separate from `getByID` so the detail page's main payload doesn't
 * grow a lookup only one section reads.
 */
const chargeContext = protectedProcedure
  .input(expenseShortcode)
  .output(
    strictOutput(
      z
        .object({
          purchase: z.object({
            id: purchaseShortcode,
            orderId: z.string().nullable(),
            date: plainDate.nullable(),
            vendorId: vendorShortcode,
            vendorName: z.string().nullable(),
          }),
          siblings: z.array(expenseOut),
        })
        .nullable(),
    ),
  )
  .query(async ({ ctx, input }) => {
    const id = await resolveLiveShortcode(ctx.db, input, "expense");
    if (!id) {
      throw createAppError("EXPENSE_NOT_FOUND", `Expense not found: ${input}`);
    }
    const self = await getExpenseByID(ctx.db, unsafeExpenseId(id));
    if (!self.purchaseId) return null;
    const purchaseId = await resolveLiveShortcode(
      ctx.db,
      self.purchaseId,
      "purchase",
    );
    if (!purchaseId) return null;
    const purchaseUuid = unsafePurchaseId(purchaseId);
    const [purchase, lines] = await Promise.all([
      getPurchaseLinkIdentityByID(ctx.db, purchaseUuid),
      getPurchaseExpenses(ctx.db, purchaseUuid),
    ]);
    if (!purchase) return null;
    return {
      purchase,
      siblings: lines.filter((row) => row.id !== input),
    };
  });

/**
 * The project x trade expense-count matrix behind project suggestions. One
 * grouped aggregate for the whole ledger, fetched once and ranked against
 * client-side for many expenses — see rankProjectSuggestions.
 */
const tradeAffinity = protectedProcedure
  .output(strictOutput(z.array(expenseTradeAffinityOut)))
  .query(({ ctx }) => expenseTradeAffinity(ctx.db));

/**
 * Rank vendor-export lines against the ledger. **Read-only — ranks, never
 * applies.** Direct-repo: no orchestration to own, so no service (and a
 * pass-through service would be an empty layer). See repo/expense/match.ts for
 * why the matcher is one wide window plus an explained residual rather than a
 * set of discrete tax hypotheses.
 */
const match = protectedProcedure
  .input(expenseMatchInput)
  .output(strictOutput(expenseMatchOut))
  .query(({ ctx, input }) => matchExpenses(ctx.db, input));

// Bulk "move to project" — projectId: null moves every listed expense to the
// inbox. Mirrors inventory.bulkMove/task.bulkMove's shape: one repo call
// inside a transaction, then one wave-wide runMutationSideEffectsForEntities
// so the embedding refresh for every moved expense batches into a single
// dispatch.
const bulkMove = protectedProcedure
  .input(expenseBulkMoveInput)
  .output(strictOutput(expenseListAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const items = await moveExpenses(ctx.db, input, ctx.actorContext);
    const ids = await expenseEntityIds(
      ctx.db,
      items.map((item) => item.id),
    );
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "expense" as const, entityId },
        source: "expense.bulkMove",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

// Bulk trade write, same wave-wide side-effect shape as bulkMove above.
const bulkSetTrade = protectedProcedure
  .input(expenseBulkTradeInput)
  .output(strictOutput(expenseListAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const items = await setExpensesTrade(ctx.db, input, ctx.actorContext);
    const ids = await expenseEntityIds(
      ctx.db,
      items.map((item) => item.id),
    );
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "expense" as const, entityId },
        source: "expense.bulkSetTrade",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

// Bulk cost-type write, same shape as bulkSetTrade.
const bulkSetCostType = protectedProcedure
  .input(expenseBulkCostTypeInput)
  .output(strictOutput(expenseListAndSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const items = await setExpensesCostType(ctx.db, input, ctx.actorContext);
    const ids = await expenseEntityIds(
      ctx.db,
      items.map((item) => item.id),
    );
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      ids.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "expense" as const, entityId },
        source: "expense.bulkSetCostType",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

export const expenseRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  list,
  create,
  update,
  delete: deleteItem,
  chartData,
  analytics,
  tradeAffinity,
  match,
  vendorOptions,
  chargeContext,
  bulkMove,
  bulkSetTrade,
  bulkSetCostType,
});
