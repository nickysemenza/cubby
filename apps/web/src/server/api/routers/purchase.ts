/**
 * Purchase Router — ONE vendor transaction per row.
 *
 * `list` comes from the shared factory; the rest is hand-rolled for the same two
 * reasons as `vendor.ts` (correlated rollups the factory can't produce, and
 * purchase is not searchable in v1), plus the three operations that have no
 * factory analogue at all: `link`, `split` and `merge`.
 *
 * There is deliberately no `splitPurchase` — one order is one purchase by
 * construction (the partial-unique `(vendorId, orderId)` index), so there is
 * nothing to split. `split` here splits an *expense* into lines of one charge.
 */

import { purchaseId } from "@cubby/schemas/identifiers";
import { expenseOut } from "@cubby/schemas/project";
import {
  linkExpensesToPurchaseInput,
  mergePurchasesInput,
  purchaseCreateInput,
  purchaseFiltersSchema,
  purchaseOut,
  purchaseSortableFields,
  purchaseUpdateInput,
  splitExpenseInput,
} from "@cubby/schemas/purchase";
import { z } from "zod";
import {
  createPurchase,
  deletePurchases,
  findPurchasesNotReconciling,
  getPurchaseByID,
  getPurchaseExpenses,
  linkExpensesToPurchase,
  mergePurchases,
  purchaseList,
  splitExpense,
  updatePurchase,
} from "~/server/repo/purchase";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { createEntityListProcedure } from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const { list } = createEntityListProcedure({
  schemas: {
    output: purchaseOut,
    filters: purchaseFiltersSchema,
    sort: {
      sortableFields: purchaseSortableFields,
      defaultSort: "date",
    },
  },
  repository: {
    list: (ctx, filters, sorts, pagination) =>
      purchaseList(ctx.db, filters, sorts, pagination),
  },
  entityName: "purchase",
});

const getByID = protectedProcedure
  .input(purchaseId)
  .output(purchaseOut)
  .query(({ ctx, input }) => getPurchaseByID(ctx.db, input));

/** This charge's lines — the expense table on a purchase detail page. */
const expenses = protectedProcedure
  .input(purchaseId)
  .output(z.array(expenseOut))
  .query(({ ctx, input }) => getPurchaseExpenses(ctx.db, input));

const create = protectedProcedure
  .input(purchaseCreateInput)
  .output(purchaseOut)
  .mutation(({ ctx, input }) =>
    createPurchase(ctx.db, input, ctx.actorContext),
  );

const update = protectedProcedure
  .input(purchaseUpdateInput)
  .output(purchaseOut)
  .mutation(({ ctx, input }) =>
    updatePurchase(ctx.db, input, ctx.actorContext),
  );

/**
 * Attach existing expenses to a charge — one invoice spanning trades. The moved
 * expenses ARE searchable, so their embeddings refresh in one wave-wide dispatch
 * (same shape as `expense.bulkMove`); the charge itself is not indexed.
 */
const link = protectedProcedure
  .input(linkExpensesToPurchaseInput)
  .output(purchaseOut)
  .mutation(async ({ ctx, input }) => {
    const result = await linkExpensesToPurchase(
      ctx.db,
      input,
      ctx.actorContext,
    );
    await runMutationSideEffectsForEntities(
      ctx.db,
      input.expenseIds.map((id) => ({
        action: "updated" as const,
        entity: { entityType: "expense" as const, entityId: id },
        source: "purchase.link",
      })),
    );
    return result;
  });

/** Split one expense into lines of the same charge. */
const split = protectedProcedure
  .input(splitExpenseInput)
  .output(z.array(expenseOut))
  .mutation(async ({ ctx, input }) => {
    const items = await splitExpense(ctx.db, input, ctx.actorContext);
    await runMutationSideEffectsForEntities(ctx.db, [
      // The original is gone and each part is new, so both sides need indexing.
      {
        action: "deleted" as const,
        entity: { entityType: "expense" as const, entityId: input.expenseId },
        source: "purchase.split",
      },
      ...items.map((item) => ({
        action: "created" as const,
        entity: { entityType: "expense" as const, entityId: item.id },
        source: "purchase.split",
      })),
    ]);
    return items;
  });

/** Merge charges the backfill couldn't group. Refuses across vendors. */
const merge = protectedProcedure
  .input(mergePurchasesInput)
  .output(purchaseOut)
  .mutation(({ ctx, input }) =>
    mergePurchases(ctx.db, input, ctx.actorContext),
  );

/**
 * Charges whose lines don't add up to their `statedTotal` — a worklist, not an
 * error. Mismatch is often correct (a partial refund reduces a line without
 * changing what the charge stated), which is why nothing rejects a write on it.
 */
const notReconciling = protectedProcedure
  .output(z.array(purchaseOut))
  .query(({ ctx }) => findPurchasesNotReconciling(ctx.db));

const deleteItem = protectedProcedure
  .input(z.object({ ids: z.array(purchaseId).min(1) }))
  .mutation(async ({ ctx, input }) => {
    await deletePurchases(ctx.db, input.ids, ctx.actorContext);
  });

export const purchaseRouter = createTRPCRouter({
  getByID,
  list,
  expenses,
  create,
  update,
  link,
  split,
  merge,
  notReconciling,
  delete: deleteItem,
});
