import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import type {
  linkExpensesToPurchaseInput,
  mergePurchasesInput,
  purchaseProductMutationInput,
  purchaseProductsInput,
  splitExpenseInput,
} from "@cubby/schemas/purchase";

import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  linkExpensesToPurchase,
  mergePurchases,
  splitExpense,
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
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

export const linkExpensesToPurchaseWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof linkExpensesToPurchaseInput._output>(
    "purchase.link",
  )
    .commit("link", ({ context }, { input }) =>
      linkExpensesToPurchase(context.db, input, context.actorContext),
    )
    .effect("expenseIds", ({ context }, { input }) =>
      resolveAllPresent(context.db, "expense", input.expenseIds),
    )
    .effect("effects", ({ context }, { expenseIds }) =>
      runMutationSideEffectsForEntities(
        context.db,
        expenseIds.map((entityId) => ({
          action: "updated" as const,
          entity: { entity: "expense" as const, id: entityId },
          source: "purchase.link",
        })),
      ),
    )
    .output(({ link }) => link),
  (
    ctx: EntityKernelContext,
    input: typeof linkExpensesToPurchaseInput._output,
  ) => ({ context: ctx, input }),
);

export const splitExpenseWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof splitExpenseInput._output>(
    "purchase.split",
  )
    .commit("split", ({ context }, { input }) =>
      splitExpense(context.db, input, context.actorContext),
    )
    .effect("references", async ({ context }, { input, split }) => {
      const originalRef = await resolveShortcode(context.db, input.expenseId);
      const newIds = await resolveAllPresent(
        context.db,
        "expense",
        split.items.map((item) => item.id),
      );
      return { originalRef, newIds };
    })
    .effect(
      "effects",
      async ({ context }, { references: { originalRef, newIds } }) => {
        await runMutationSideEffectsForEntities(context.db, [
          ...(originalRef?.entity === "expense"
            ? [
                {
                  action: "deleted" as const,
                  entity: {
                    entity: "expense" as const,
                    id: parseEntityId("expense", originalRef.id),
                  },
                  source: "purchase.split",
                },
              ]
            : []),
          ...newIds.map((entityId) => ({
            action: "created" as const,
            entity: { entity: "expense" as const, id: entityId },
            source: "purchase.split",
          })),
        ]);
      },
    )
    .effect("pricing", async ({ context }, { split }) => {
      if (split.priceAffectedProductIds.length > 0) {
        await recomputeRecipesForPriceAffectedProducts(
          context.db,
          context.services.recipeCosting,
          split.priceAffectedProductIds,
          "purchase.split",
        );
      }
    })
    .output(({ split }) => split.items),
  (ctx: EntityKernelContext, input: typeof splitExpenseInput._output) => ({
    context: ctx,
    input,
  }),
);

export const mergePurchasesWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof mergePurchasesInput._output>(
    "purchase.merge",
  )
    .commit("merge", ({ context }, { input }) =>
      mergePurchases(context.db, input, context.actorContext),
    )
    .effect("entityId", ({ context }, { merge }) =>
      resolveLiveShortcode(context.db, merge.purchase.id, "purchase"),
    )
    .effect("effects", async ({ context }, { entityId }) =>
      entityId
        ? runMutationSideEffects(context.db, {
            action: "updated",
            entity: {
              entity: "purchase",
              id: parseEntityId("purchase", entityId),
            },
            source: "purchase.merge",
          })
        : null,
    )
    .output(({ merge }) => merge),
  (ctx: EntityKernelContext, input: typeof mergePurchasesInput._output) => ({
    context: ctx,
    input,
  }),
);

async function resolvePurchaseProductIds(
  ctx: EntityKernelContext,
  input: { purchaseId: string; productIds?: ProductShortcode[] },
) {
  const purchaseId = await resolveOrThrow(ctx.db, "purchase", input.purchaseId);
  const productIds = input.productIds
    ? await resolveAllOrThrow(ctx.db, "product", input.productIds)
    : [];
  return { purchaseId, productIds };
}

export const purchaseProductsWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof purchaseProductsInput._output>(
    "purchase.products",
  )
    .call("ids", async ({ context }, { input }) =>
      resolvePurchaseProductIds(context, input),
    )
    .call("products", async ({ context }, { ids }) =>
      listPurchaseProducts(context.readDb, ids.purchaseId),
    )
    .output(({ products }) => products),
  (ctx: EntityKernelContext, input: typeof purchaseProductsInput._output) => ({
    context: ctx,
    input,
  }),
);

export const attachPurchaseProductsWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof purchaseProductMutationInput._output>(
    "purchase.attachProducts",
  )
    .call("ids", ({ context }, { input }) =>
      resolvePurchaseProductIds(context, input),
    )
    .commit("attach", ({ context }, { ids }) =>
      attachPurchaseProducts(
        context.db,
        ids.purchaseId,
        ids.productIds,
        context.actorContext,
      ),
    )
    .output(({ attach }) => attach),
  (
    ctx: EntityKernelContext,
    input: typeof purchaseProductMutationInput._output,
  ) => ({ context: ctx, input }),
);

export const detachPurchaseProductsWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof purchaseProductMutationInput._output>(
    "purchase.detachProducts",
  )
    .call("ids", ({ context }, { input }) =>
      resolvePurchaseProductIds(context, input),
    )
    .commit("detach", ({ context }, { ids }) =>
      detachPurchaseProducts(
        context.db,
        ids.purchaseId,
        ids.productIds,
        context.actorContext,
      ),
    )
    .output(({ detach }) => detach),
  (
    ctx: EntityKernelContext,
    input: typeof purchaseProductMutationInput._output,
  ) => ({ context: ctx, input }),
);
