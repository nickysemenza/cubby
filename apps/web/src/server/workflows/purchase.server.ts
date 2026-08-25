import type { ProductShortcode } from "@cubby/schemas/identifiers";
import { unsafeExpenseId, unsafePurchaseId } from "@cubby/schemas/identifiers";
import {
  linkExpensesToPurchaseInput,
  mergePurchasesInput,
  mergePurchasesOut,
  purchaseOut,
  purchaseProductMutationInput,
  purchaseProductMutationOut,
  purchaseProductsInput,
  purchaseProductsOut,
  splitExpenseInput,
  splitExpenseOut,
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

export {
  linkExpensesToPurchaseInput,
  mergePurchasesInput,
  mergePurchasesOut,
  purchaseOut,
  purchaseProductMutationInput,
  purchaseProductMutationOut,
  purchaseProductsInput,
  purchaseProductsOut,
  splitExpenseInput,
  splitExpenseOut,
};

export async function linkExpensesToPurchaseWorkflow(
  ctx: EntityKernelContext,
  input: typeof linkExpensesToPurchaseInput._output,
) {
  const result = await linkExpensesToPurchase(ctx.db, input, ctx.actorContext);
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
}

export async function splitExpenseWorkflow(
  ctx: EntityKernelContext,
  input: typeof splitExpenseInput._output,
) {
  const { items, priceAffectedProductIds } = await splitExpense(
    ctx.db,
    input,
    ctx.actorContext,
  );
  const originalRef = await resolveShortcode(ctx.db, input.expenseId);
  const newIds = await resolveAllPresent(
    ctx.db,
    "expense",
    items.map((item) => item.id),
  );
  await runMutationSideEffectsForEntities(ctx.db, [
    ...(originalRef?.entity === "expense"
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
}

export async function mergePurchasesWorkflow(
  ctx: EntityKernelContext,
  input: typeof mergePurchasesInput._output,
) {
  const output = await mergePurchases(ctx.db, input, ctx.actorContext);
  const entityId = await resolveLiveShortcode(
    ctx.db,
    output.purchase.id,
    "purchase",
  );
  if (entityId) {
    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "purchase", entityId: unsafePurchaseId(entityId) },
      source: "purchase.merge",
    });
  }
  return output;
}

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

export async function purchaseProductsWorkflow(
  ctx: EntityKernelContext,
  input: typeof purchaseProductsInput._output,
) {
  const ids = await resolvePurchaseProductIds(ctx, input);
  return listPurchaseProducts(ctx.readDb, ids.purchaseId);
}

export async function attachPurchaseProductsWorkflow(
  ctx: EntityKernelContext,
  input: typeof purchaseProductMutationInput._output,
) {
  const ids = await resolvePurchaseProductIds(ctx, input);
  return attachPurchaseProducts(
    ctx.db,
    ids.purchaseId,
    ids.productIds,
    ctx.actorContext,
  );
}

export async function detachPurchaseProductsWorkflow(
  ctx: EntityKernelContext,
  input: typeof purchaseProductMutationInput._output,
) {
  const ids = await resolvePurchaseProductIds(ctx, input);
  return detachPurchaseProducts(
    ctx.db,
    ids.purchaseId,
    ids.productIds,
    ctx.actorContext,
  );
}
