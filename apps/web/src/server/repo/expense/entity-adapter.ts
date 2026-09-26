import {
  bulkUpdatedWithSideEffects,
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";

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
      await recomputeRecipesForPriceAffectedProducts(
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
      };
    },
    bulkUpdate: async (ctx, ids, data) =>
      bulkUpdatedWithSideEffects(
        ctx,
        "expense",
        await updateExpensesInBulk(ctx.db, ids, data, ctx.actorContext),
      ),
  },
});
