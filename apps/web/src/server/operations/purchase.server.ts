import { parseEntityId } from "@cubby/schemas/identifiers";
import type {
  linkExpensesToPurchaseInput,
  purchaseProductsInput,
  splitExpenseInput,
} from "@cubby/schemas/purchase";

import { purchaseContract } from "~/contracts/purchase.contract";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { listPurchaseOrderMail } from "~/server/purchase-import/gmail/review";
import { linkExpensesToPurchase, splitExpense } from "~/server/repo/purchase";
import { listPurchaseProducts } from "~/server/repo/purchase-products";
import {
  resolveAllPresent,
  resolveOrThrow,
  resolveShortcode,
} from "~/server/repo/shortcode-resolver";
import { recomputeRecipesForPriceAffectedProducts } from "~/server/services/expense-pricing.service";
import {
  mutationEvents,
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
        mutationEvents("expense", "updated", expenseIds, "purchase.link"),
      ),
    )
    .output(({ link }) => link),
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
            ? mutationEvents(
                "expense",
                "deleted",
                [parseEntityId("expense", originalRef.id)],
                "purchase.split",
              )
            : []),
          ...mutationEvents("expense", "created", newIds, "purchase.split"),
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
);

export async function purchaseProductsWorkflow(
  context: EntityKernelContext,
  input: typeof purchaseProductsInput._output,
) {
  return listPurchaseProducts(
    context.db,
    await resolveOrThrow(context.db, "purchase", input.purchaseId),
  );
}

export const purchaseHandlers = implementOperationDomain(purchaseContract, {
  orderMail: (context, input) => listPurchaseOrderMail(context.db, input),
  products: (context, input) => purchaseProductsWorkflow(context, input),
  link: (context, input) => linkExpensesToPurchaseWorkflow(context, input),
  split: (context, input) => splitExpenseWorkflow(context, input),
});
