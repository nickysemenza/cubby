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

import {
  purchaseShortcode,
  unsafeExpenseId,
  unsafePurchaseId,
} from "@cubby/schemas/identifiers";
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
  getPurchaseByID,
  getPurchaseByShortcode,
  getPurchaseExpenses,
  linkExpensesToPurchase,
  mergePurchases,
  purchaseList,
  splitExpense,
  updatePurchase,
} from "~/server/repo/purchase";
import {
  resolveLiveShortcode,
  resolveLiveShortcodes,
  resolveShortcode,
} from "~/server/repo/shortcode-resolver";
import { createAppError } from "~/server/errors/app-error";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import {
  createEntityListProcedure,
  createGetByShortcodeProcedure,
} from "../crud-factory";
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
  .input(purchaseShortcode)
  .output(purchaseOut)
  .query(async ({ ctx, input }) => {
    const id = await resolveLiveShortcode(ctx.db, input, "purchase");
    if (!id) {
      throw createAppError("PURCHASE_NOT_FOUND", `Purchase not found: ${input}`);
    }
    return getPurchaseByID(ctx.db, unsafePurchaseId(id));
  });

const getByShortcode = createGetByShortcodeProcedure(
  "purchase",
  purchaseOut,
  (ctx, shortcode) => getPurchaseByShortcode(ctx.db, shortcode),
);

/** This charge's lines — the expense table on a purchase detail page. */
const expenses = protectedProcedure
  .input(purchaseShortcode)
  .output(z.array(expenseOut))
  .query(async ({ ctx, input }) => {
    const id = await resolveLiveShortcode(ctx.db, input, "purchase");
    if (!id) {
      throw createAppError("PURCHASE_NOT_FOUND", `Purchase not found: ${input}`);
    }
    return getPurchaseExpenses(ctx.db, unsafePurchaseId(id));
  });

const create = protectedProcedure
  .input(purchaseCreateInput)
  .output(purchaseOut)
  .mutation(
    async ({ ctx, input }) =>
      (await createPurchase(ctx.db, input, ctx.actorContext)).output,
  );

const update = protectedProcedure
  .input(purchaseUpdateInput)
  .output(purchaseOut)
  .mutation(
    async ({ ctx, input }) =>
      (await updatePurchase(ctx.db, input, ctx.actorContext)).output,
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
    const resolved = await resolveLiveShortcodes(
      ctx.db,
      input.expenseIds,
      "expense",
    );
    await runMutationSideEffectsForEntities(
      ctx.db,
      input.expenseIds.flatMap((code) => {
        const uuid = resolved.get(code);
        return uuid
          ? [
              {
                action: "updated" as const,
                entity: {
                  entityType: "expense" as const,
                  entityId: unsafeExpenseId(uuid),
                },
                source: "purchase.link",
              },
            ]
          : [];
      }),
    );
    return result;
  });

/** Split one expense into lines of the same charge. */
const split = protectedProcedure
  .input(splitExpenseInput)
  .output(z.array(expenseOut))
  .mutation(async ({ ctx, input }) => {
    const items = await splitExpense(ctx.db, input, ctx.actorContext);
    // The original is already soft-deleted by the time we get here —
    // `resolveShortcode` (not the live-only variant) is what still names it.
    const originalRef = await resolveShortcode(ctx.db, input.expenseId);
    const newIds = await resolveLiveShortcodes(
      ctx.db,
      items.map((item) => item.id),
      "expense",
    );
    await runMutationSideEffectsForEntities(ctx.db, [
      // The original is gone and each part is new, so both sides need indexing.
      ...(originalRef && originalRef.entity === "expense"
        ? [
            {
              action: "deleted" as const,
              entity: {
                entityType: "expense" as const,
                entityId: unsafeExpenseId(originalRef.id),
              },
              source: "purchase.split",
            },
          ]
        : []),
      ...items.flatMap((item) => {
        const uuid = newIds.get(item.id);
        return uuid
          ? [
              {
                action: "created" as const,
                entity: {
                  entityType: "expense" as const,
                  entityId: unsafeExpenseId(uuid),
                },
                source: "purchase.split",
              },
            ]
          : [];
      }),
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

const deleteItem = protectedProcedure
  .input(z.object({ ids: z.array(purchaseShortcode).min(1) }))
  .mutation(async ({ ctx, input }) => {
    await deletePurchases(ctx.db, input.ids, ctx.actorContext);
  });

export const purchaseRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  list,
  expenses,
  create,
  update,
  link,
  split,
  merge,
  delete: deleteItem,
});
