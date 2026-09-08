import { expenseSortableFields } from "@cubby/schemas/project";

import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

import {
  createExpense,
  deleteExpensesWithPurchaseEffects,
  EXPENSE_DELETE_EDGE_POLICY,
  getExpenseByShortcode,
  updateExpensesInBulk,
  updateExpense,
} from "./crud";
import { expenseList } from "./lookup";

export const expenseEntityAdapter = defineEntityAdapter({
  entity: "expense",
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
      return {
        deletedReferences: entityMutationReferences(
          "expense",
          result.deletedIds,
        ),
        backgroundBatches,
      };
    },
    /** One complete patch, one transaction, then one side-effect fan-out. */
    bulkUpdate: async (ctx, ids, data) => {
      const result = await updateExpensesInBulk(
        ctx.db,
        ids,
        data,
        ctx.actorContext,
      );
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        result.updatedIds.map((entityId) => ({
          action: "updated" as const,
          entity: { entity: "expense" as const, id: entityId },
          source: "expense.bulkUpdate",
        })),
      );
      return {
        updatedReferences: entityMutationReferences(
          "expense",
          result.updatedShortcodes,
        ),
        backgroundBatches,
      };
    },
  },
});
