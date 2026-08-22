/**
 * Purchase Router — one vendor order/receipt event per row.
 *
 * Standard CRUD comes from the shared searchable factory; spread in alongside
 * are the operations that have no factory analogue at all: `link`, `split`,
 * `merge`, `reclassifyDocument` and `deleteEmpty`.
 *
 * There is deliberately no `splitPurchase` — one order is one purchase by
 * construction (the partial-unique `(vendorId, orderId)` index), so there is
 * nothing to split. `split` here splits an *expense* into lines of one charge.
 */

import type { ProductShortcode } from "@cubby/schemas/identifiers";
import {
  purchaseShortcode,
  unsafeExpenseId,
  unsafePurchaseId,
  unsafePurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { expenseOut } from "@cubby/schemas/project";
import {
  deleteEmptyPurchasesInput,
  deleteEmptyPurchasesOut,
  linkExpensesToPurchaseInput,
  mergePurchasesInput,
  purchaseCreateInput,
  purchaseFiltersSchema,
  purchaseOut,
  purchaseProductMutationInput,
  purchaseProductMutationOut,
  purchaseProductsInput,
  purchaseProductsOut,
  purchaseSortableFields,
  purchaseUpdateData,
  reclassifyPurchaseDocumentInput,
  splitExpenseInput,
} from "@cubby/schemas/purchase";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import {
  createPurchase,
  deleteEmptyPurchases,
  deletePurchases,
  getPurchaseByShortcode,
  linkExpensesToPurchase,
  mergePurchases,
  purchaseList,
  reclassifyPurchaseDocument,
  splitExpense,
  updatePurchase,
} from "~/server/repo/purchase";
import {
  attachPurchaseProducts,
  detachPurchaseProducts,
  listPurchaseProducts,
} from "~/server/repo/purchase-products";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveLiveShortcode,
  resolveOrThrow,
  resolveShortcode,
} from "~/server/repo/shortcode-resolver";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const procedures = createSearchableEntityCrudProcedures({
  schemas: {
    createInput: purchaseCreateInput,
    updateInput: purchaseUpdateData,
    output: purchaseOut,
    filters: purchaseFiltersSchema,
    sort: {
      sortableFields: purchaseSortableFields,
      defaultSort: "date",
    },
    idSchema: purchaseShortcode,
  },
  repository: {
    getByID: async (ctx, id) => {
      const out = await getPurchaseByShortcode(ctx.db, id);
      if (!out) {
        throw createAppError("PURCHASE_NOT_FOUND", `Purchase not found: ${id}`);
      }
      return out;
    },
    getByShortcode: (ctx, shortcode) =>
      getPurchaseByShortcode(ctx.db, shortcode),
    list: (ctx, filters, sorts, pagination) =>
      purchaseList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createPurchase(ctx.db, data, ctx.actorContext),
    update: async (ctx, id, data) => {
      const { output, entityId, detachedImageKeys } = await updatePurchase(
        ctx.db,
        { id: unsafePurchaseShortcode(id), data },
        ctx.actorContext,
      );
      // After the commit, never inside it: an R2 delete has no rollback. The
      // keys are destructured off here so they never reach `strictOutput`.
      await deleteStoredObjects(detachedImageKeys);
      return { output, entityId };
    },
    /**
     * NOT a plain repo passthrough. Deleting a purchase DETACHES the expenses
     * and financial transactions that pointed at it, and those rows embed the
     * purchase's identity — so each one has to be reindexed even though the
     * factory's own delete side-effect only ever sees the purchase itself.
     * `deletePurchases` returns exactly those detached ids for that purpose;
     * dropping this dispatch would silently leave them stale, with no compiler
     * signal. Covered by searchable-crud.integration.test.ts.
     */
    delete: async (ctx, ids) => {
      const detached = await deletePurchases(
        ctx.db,
        ids.map(unsafePurchaseShortcode),
        ctx.actorContext,
      );
      // After the commit, never inside it: an R2 delete has no rollback.
      await deleteStoredObjects(detached.detachedImageKeys);
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        [
          ...detached.expenseIds.map((entityId) => ({
            action: "updated" as const,
            entity: { entityType: "expense" as const, entityId },
            source: "purchase.delete",
          })),
          ...detached.financialTransactionIds.map((entityId) => ({
            action: "updated" as const,
            entity: {
              entityType: "financialTransaction" as const,
              entityId,
            },
            source: "purchase.delete",
          })),
        ],
      );
      return { deleted: detached.deleted, backgroundBatches };
    },
  },
  entityName: "purchase",
});

/**
 * Attach existing expenses to a charge — one invoice spanning trades. The moved
 * expenses are searchable, so their embeddings refresh in one wave-wide dispatch
 * (same shape as `expense.bulkMove`). Purchase identity itself is unchanged.
 */
const link = protectedProcedure
  .input(linkExpensesToPurchaseInput)
  .output(strictOutput(purchaseOut))
  .mutation(async ({ ctx, input }) => {
    const result = await linkExpensesToPurchase(
      ctx.db,
      input,
      ctx.actorContext,
    );
    const resolvedIds = await resolveAllPresent(
      ctx.db,
      "expense",
      input.expenseIds,
    );
    await runMutationSideEffectsForEntities(
      ctx.db,
      resolvedIds.map((entityId) => ({
        action: "updated" as const,
        entity: { entityType: "expense" as const, entityId },
        source: "purchase.link",
      })),
    );
    return result;
  });

/** Split one expense into lines of the same charge. */
const split = protectedProcedure
  .input(splitExpenseInput)
  .output(strictOutput(z.array(expenseOut)))
  .mutation(async ({ ctx, input }) => {
    const { items, priceAffectedProductIds } = await splitExpense(
      ctx.db,
      input,
      ctx.actorContext,
    );
    // The original is already soft-deleted by the time we get here —
    // `resolveShortcode` (not the live-only variant) is what still names it.
    const originalRef = await resolveShortcode(ctx.db, input.expenseId);
    const newIds = await resolveAllPresent(
      ctx.db,
      "expense",
      items.map((item) => item.id),
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
      ...newIds.map((entityId) => ({
        action: "created" as const,
        entity: { entityType: "expense" as const, entityId },
        source: "purchase.split",
      })),
    ]);
    if (priceAffectedProductIds.length > 0) {
      await recomputeRecipesForPriceAffectedProducts(
        ctx.db,
        ctx.services.recipeCosting,
        priceAffectedProductIds,
        "purchase.split",
      );
    }
    return items;
  });

/** Merge charges the backfill couldn't group. Refuses across vendors. */
const merge = protectedProcedure
  .input(mergePurchasesInput)
  .output(strictOutput(purchaseOut))
  .mutation(async ({ ctx, input }) => {
    const output = await mergePurchases(ctx.db, input, ctx.actorContext);
    const entityId = await resolveLiveShortcode(ctx.db, output.id, "purchase");
    if (entityId) {
      await runMutationSideEffects(ctx.db, {
        action: "updated",
        entity: {
          entityType: "purchase",
          entityId: unsafePurchaseId(entityId),
        },
        source: "purchase.merge",
      });
    }
    return output;
  });

const reclassifyDocument = protectedProcedure
  .input(reclassifyPurchaseDocumentInput)
  .output(strictOutput(purchaseOut))
  .mutation(({ ctx, input }) =>
    reclassifyPurchaseDocument(ctx.db, input, ctx.actorContext),
  );

const deleteEmpty = protectedProcedure
  .input(deleteEmptyPurchasesInput)
  .output(strictOutput(deleteEmptyPurchasesOut))
  .mutation(async ({ ctx, input }) => {
    const { shortcodes: deletedIds, detachedImageKeys } =
      await deleteEmptyPurchases(ctx.db, input.ids, ctx.actorContext);
    // After the commit, never inside it: an R2 delete has no rollback.
    await deleteStoredObjects(detachedImageKeys);
    return { deleted: deletedIds.length, deletedIds };
  });

/**
 * Resolve a purchase-product mutation/query's shortcodes to live ids in one
 * shot. Mirrors `resolveProjectResourceIds` in the project router.
 */
async function resolvePurchaseProductIds(
  db: Parameters<typeof resolveOrThrow>[0],
  input: { purchaseId: string; productIds?: ProductShortcode[] },
) {
  const purchaseId = await resolveOrThrow(db, "purchase", input.purchaseId);
  if (!input.productIds) {
    return { purchaseId, productIds: [] };
  }
  const productIds = await resolveAllOrThrow(db, "product", input.productIds);
  return { purchaseId, productIds };
}

/**
 * The Products linked to one Purchase. This link carries no money and is not
 * a second spend path — see `packages/schemas/src/purchase.ts` for why it
 * exists (lump-sum/installment Expenses can't carry a productId).
 */
const products = protectedProcedure
  .input(purchaseProductsInput)
  .output(strictOutput(purchaseProductsOut))
  .query(async ({ ctx, input }) => {
    const ids = await resolvePurchaseProductIds(ctx.db, input);
    return listPurchaseProducts(ctx.db, ids.purchaseId);
  });

const attachProducts = protectedProcedure
  .input(purchaseProductMutationInput)
  .output(strictOutput(purchaseProductMutationOut))
  .mutation(async ({ ctx, input }) => {
    const ids = await resolvePurchaseProductIds(ctx.db, input);
    return attachPurchaseProducts(
      ctx.db,
      ids.purchaseId,
      ids.productIds,
      ctx.actorContext,
    );
  });

const detachProducts = protectedProcedure
  .input(purchaseProductMutationInput)
  .output(strictOutput(purchaseProductMutationOut))
  .mutation(async ({ ctx, input }) => {
    const ids = await resolvePurchaseProductIds(ctx.db, input);
    return detachPurchaseProducts(
      ctx.db,
      ids.purchaseId,
      ids.productIds,
      ctx.actorContext,
    );
  });

export const purchaseRouter = createTRPCRouter({
  ...procedures,
  link,
  split,
  merge,
  reclassifyDocument,
  deleteEmpty,
  products,
  attachProducts,
  detachProducts,
});
