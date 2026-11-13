import { expenseSchemaBindings } from "~/entity/generated/entity-schema-bindings.expense.gen";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/domains/expense/repo/price-affected-recipes";
import { defineRepository } from "~/server/entity-kernel/repo/repository";

import {
  createExpense,
  deleteExpensesWithPurchaseEffects,
  updateExpense,
} from "./crud";
import { expenseScaffold } from "./lookup";

export const expenseRepository = defineRepository("expense", {
  schemas: expenseSchemaBindings,
  lifecycle: { delete: DECLARED_EDGE_DELETE_POLICIES.expense },
  scaffold: expenseScaffold,
  create: async (ctx, data) => {
    const result = await createExpense(
      ctx.db,
      data,
      ctx.actorContext,
      ctx.services.expenseLineRole,
    );
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
  createRead: async (ctx, data, fields) => {
    const result = await createExpense.read(
      fields,
      ctx.db,
      data,
      ctx.actorContext,
      ctx.services.expenseLineRole,
    );
    await recomputeRecipesForPriceAffectedProducts(
      ctx.db,
      ctx.services.recipeCosting,
      result.priceAffectedProductIds,
      "expense.create",
    );
    return result;
  },
  updateRead: async (ctx, id, data, fields) => {
    const result = await updateExpense.read(
      fields,
      ctx.db,
      id,
      data,
      ctx.actorContext,
    );
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
    return { removed: result.deletedIds };
  },
});
