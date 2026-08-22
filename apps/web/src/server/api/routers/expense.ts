/**
 * Expense Router — project spend ledger (migrated from Notion).
 * Pure crud-factory shape; no children, no rollups of its own.
 */

import {
  type ExpenseShortcode,
  expenseShortcode,
  purchaseShortcode,
  unsafePurchaseId,
  vendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  deleteExpensesWithPurchaseEffectsInput,
  deleteExpensesWithPurchaseEffectsOut,
  expenseAnalyticsOut,
  expenseAnalyzeInput,
  expenseAnalyzeOut,
  expenseBulkCostTypeInput,
  expenseBulkMoveInput,
  expenseBulkTradeInput,
  expenseCreateInput,
  expenseFacetCountsInput,
  expenseFacetCountsOut,
  expenseFiltersSchema,
  expenseMatchInput,
  expenseMatchOut,
  expenseMonthlySummaryOut,
  expenseOut,
  expenseSortableFields,
  expenseTradeAffinityOut,
  expenseUpdateData,
  plainDate,
} from "@cubby/schemas/project";
import { vendorOptionsOut } from "@cubby/schemas/vendor";
import { z } from "zod";
import {
  createExpense,
  deleteExpensesWithPurchaseEffects,
  expenseAnalytics,
  expenseAnalyze,
  expenseFacetCounts,
  expenseList,
  expenseMonthlySummary,
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
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { vendorOptions as loadVendorOptions } from "~/server/repo/vendor";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import { TraceNames, withTrace } from "~/server/tracing";
import {
  createBulkUpdatedMutation,
  createSearchableEntityCrudProcedures,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";
import {
  expenseAnalyzeTraceAttributes,
  expenseFacetTraceAttributes,
} from "./expense-observability";

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
      const id = await resolveOrThrow(services.db, "expense", shortcode);
      return getExpenseByID(services.db, id);
    },
    getByShortcode: (services, shortcode) =>
      getExpenseByShortcode(services.db, shortcode),
    list: async (services, filters, sort, pagination) =>
      expenseList(services.db, filters, sort, pagination),
    // The repo hands back the uuid alongside the output, so neither of these
    // re-resolves a code it just had.
    create: async (services, data) => {
      const result = await createExpense(
        services.db,
        data,
        services.actorContext,
      );
      await recomputeRecipesForPriceAffectedProducts(
        services.db,
        services.services.recipeCosting,
        result.priceAffectedProductIds,
        "expense.create",
      );
      return result;
    },
    update: async (services, shortcode: ExpenseShortcode, data) => {
      const result = await updateExpense(
        services.db,
        shortcode,
        data,
        services.actorContext,
      );
      await recomputeRecipesForPriceAffectedProducts(
        services.db,
        services.services.recipeCosting,
        result.priceAffectedProductIds,
        "expense.update",
      );
      return result;
    },
    delete: async (services, ids: ExpenseShortcode[]) => {
      // The richer sibling of `deleteExpenses`, not the wrapper itself — this
      // is the one call site that needs `result.deleted` (measured off
      // `removeEntity`, not asserted from `ids.length`) alongside the
      // price-affected product ids the legacy wrapper already returned.
      const { priceAffectedProductIds, result } =
        await deleteExpensesWithPurchaseEffects(
          services.db,
          ids,
          services.actorContext,
        );
      const backgroundBatches = await recomputeRecipesForPriceAffectedProducts(
        services.db,
        services.services.recipeCosting,
        priceAffectedProductIds,
        "expense.delete",
      );
      return { deleted: result.deleted, backgroundBatches };
    },
  },
  entityName: "expense",
});

const deleteWithPurchaseEffects = protectedProcedure
  .input(deleteExpensesWithPurchaseEffectsInput)
  .output(strictOutput(deleteExpensesWithPurchaseEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const deletion = await deleteExpensesWithPurchaseEffects(
      ctx.db,
      input.ids,
      ctx.actorContext,
    );
    await recomputeRecipesForPriceAffectedProducts(
      ctx.db,
      ctx.services.recipeCosting,
      deletion.priceAffectedProductIds,
      "expense.delete",
    );
    return deletion.result;
  });

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

const monthlySummary = protectedProcedure
  .input(expenseFiltersSchema)
  .output(strictOutput(expenseMonthlySummaryOut))
  .query(({ ctx, input }) => expenseMonthlySummary(ctx.db, input));

/**
 * Complete server-side aggregate grid for the Expenses Analyze section. Unlike
 * the paginated ledger, this procedure never derives totals from loaded rows.
 */
const analyze = protectedProcedure
  .input(expenseAnalyzeInput)
  .output(strictOutput(expenseAnalyzeOut))
  .query(({ ctx, input }) =>
    withTrace(TraceNames.service("expense", "analyze"), async (span) => {
      span.setAttributes(expenseAnalyzeTraceAttributes(input));
      const result = await expenseAnalyze(ctx.db, input);
      span.setAttributes(expenseAnalyzeTraceAttributes(input, result));
      return result;
    }),
  );

/**
 * Filter-option counts under the canonical ledger population. A facet omits
 * only its own predicate so users can see viable alternatives before changing
 * that control.
 */
const facetCounts = protectedProcedure
  .input(expenseFacetCountsInput)
  .output(strictOutput(expenseFacetCountsOut))
  .query(({ ctx, input }) =>
    withTrace(TraceNames.service("expense", "facetCounts"), async (span) => {
      span.setAttributes(expenseFacetTraceAttributes(input));
      const result = await expenseFacetCounts(ctx.db, input);
      span.setAttributes(expenseFacetTraceAttributes(input, result));
      return result;
    }),
  );

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
            displayLabel: z.string().nullable(),
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
    const id = await resolveOrThrow(ctx.db, "expense", input);
    const self = await getExpenseByID(ctx.db, id);
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
const bulkMove = createBulkUpdatedMutation({
  input: expenseBulkMoveInput,
  itemOutput: expenseOut,
  entity: "expense",
  source: "expense.bulkMove",
  mutate: (ctx, input) => moveExpenses(ctx.db, input, ctx.actorContext),
  entityShortcodes: (items) => items.map((item) => item.id),
});

// Bulk trade write, same wave-wide side-effect shape as bulkMove above.
const bulkSetTrade = createBulkUpdatedMutation({
  input: expenseBulkTradeInput,
  itemOutput: expenseOut,
  entity: "expense",
  source: "expense.bulkSetTrade",
  mutate: (ctx, input) => setExpensesTrade(ctx.db, input, ctx.actorContext),
  entityShortcodes: (items) => items.map((item) => item.id),
});

// Bulk cost-type write, same shape as bulkSetTrade.
const bulkSetCostType = createBulkUpdatedMutation({
  input: expenseBulkCostTypeInput,
  itemOutput: expenseOut,
  entity: "expense",
  source: "expense.bulkSetCostType",
  mutate: (ctx, input) => setExpensesCostType(ctx.db, input, ctx.actorContext),
  entityShortcodes: (items) => items.map((item) => item.id),
});

export const expenseRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  list,
  create,
  update,
  delete: deleteItem,
  deleteWithPurchaseEffects,
  chartData,
  analytics,
  monthlySummary,
  analyze,
  facetCounts,
  tradeAffinity,
  match,
  vendorOptions,
  chargeContext,
  bulkMove,
  bulkSetTrade,
  bulkSetCostType,
});
