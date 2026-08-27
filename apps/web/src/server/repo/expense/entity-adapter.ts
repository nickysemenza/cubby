import type { ExpenseShortcode } from "@cubby/schemas/identifiers";
import {
  expenseFiltersSchema,
  expenseSortableFields,
} from "@cubby/schemas/project";
import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import { resolveAllPresent } from "~/server/repo/shortcode-resolver";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import {
  createExpense,
  deleteExpensesWithPurchaseEffects,
  EXPENSE_DELETE_EDGE_POLICY,
  getExpenseByShortcode,
  moveExpenses,
  setExpensesCostType,
  setExpensesTrade,
  updateExpense,
} from "./crud";
import { expenseList } from "./lookup";

export const expenseEntityAdapter = defineEntityAdapter({
  entity: "expense",
  filters: expenseFiltersSchema,
  sort: {
    fields: expenseSortableFields,
    default: "date",
    groupable: ["costType"],
  },
  lifecycle: { delete: EXPENSE_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getExpenseByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      expenseList(ctx.db, filters, sorts, pagination),
    create: async (ctx, data) => {
      const result = await createExpense(ctx.db, data, ctx.actorContext);
      await recomputeRecipesForPriceAffectedProducts(
        ctx.db,
        ctx.services.recipeCosting,
        result.priceAffectedProductIds,
        "expense.create",
      );
      return result;
    },
    update: async (ctx, id, data) => {
      const result = await updateExpense(ctx.db, id, data, ctx.actorContext);
      await recomputeRecipesForPriceAffectedProducts(
        ctx.db,
        ctx.services.recipeCosting,
        result.priceAffectedProductIds,
        "expense.update",
      );
      return result;
    },
    delete: async (ctx, ids) => {
      const { priceAffectedProductIds, result } =
        await deleteExpensesWithPurchaseEffects(ctx.db, ids, ctx.actorContext);
      const backgroundBatches = await recomputeRecipesForPriceAffectedProducts(
        ctx.db,
        ctx.services.recipeCosting,
        priceAffectedProductIds,
        "expense.delete",
      );
      return { deleted: result.deleted, backgroundBatches };
    },
    /**
     * The kernel's `bulkUpdate` branch runs no side effects (it is shaped like
     * `delete`, not `update`), so the per-row fan-out that used to live in
     * `expense.server.ts`'s `bulkExpense` wrapper is dispatched here. No price
     * recompute: none of the declared fields feeds a product price, which is
     * why the bulk writes were never routed through `updateExpense`.
     */
    bulkUpdate: async (ctx, ids, data) => {
      const touched = new Set<ExpenseShortcode>();
      const collect = async (rows: Promise<{ id: ExpenseShortcode }[]>) => {
        for (const row of await rows) touched.add(row.id);
      };
      if (data.projectId !== undefined) {
        await collect(
          moveExpenses(
            ctx.db,
            { ids, projectId: data.projectId },
            ctx.actorContext,
          ),
        );
      }
      if (data.trade !== undefined) {
        await collect(
          setExpensesTrade(
            ctx.db,
            { ids, trade: data.trade },
            ctx.actorContext,
          ),
        );
      }
      if (data.costType !== undefined) {
        await collect(
          setExpensesCostType(
            ctx.db,
            { ids, costType: data.costType },
            ctx.actorContext,
          ),
        );
      }
      const shortcodes = [...touched];
      const entityIds = await resolveAllPresent(ctx.db, "expense", shortcodes);
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        entityIds.map((entityId) => ({
          action: "updated" as const,
          entity: { entityType: "expense" as const, entityId },
          source: "expense.bulkUpdate",
        })),
      );
      return { updated: shortcodes.length, backgroundBatches };
    },
  },
});
