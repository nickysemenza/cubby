import { financialTransactionOut } from "@cubby/schemas/financial-transaction";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { expenseOut } from "@cubby/schemas/project";
import {
  type linkExpensesToPurchaseInput,
  type purchaseProductsInput,
  type purchaseSettlementCandidatesOut,
  splitExpenseDelta,
  type splitExpenseInput,
} from "@cubby/schemas/purchase";

import { purchaseContract } from "~/contracts/purchase.contract";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { listPurchaseOrderMail } from "~/server/purchase-import/gmail/review";
import {
  linkExpensesToPurchase,
  reclassifyPurchaseDocument,
  splitExpense,
} from "~/server/repo/purchase";
import { listPurchaseProducts } from "~/server/repo/purchase-products";
import { listPurchaseSettlementCandidates } from "~/server/repo/purchase-settlement-candidates";
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
  settlementCandidates: async (context, input) => {
    const candidates = await listPurchaseSettlementCandidates(
      context.db,
      input.purchaseId,
    );
    return {
      advisory: true,
      candidates: await Promise.all(
        candidates.map(async ({ transactionId, ...rank }) => {
          const result = await executeEntity(context, {
            action: "get",
            entity: "financialTransaction",
            id: parseShortcodeFor("financialTransaction", transactionId),
            missing: "error",
          });
          if (result.action !== "get" || !result.item)
            throw new Error(
              "Entity kernel returned the wrong financial transaction detail",
            );
          return {
            ...rank,
            transaction: financialTransactionOut.parse(result.item),
          };
        }),
      ),
    } satisfies typeof purchaseSettlementCandidatesOut._output;
  },
  orderMail: (context, input) => listPurchaseOrderMail(context.db, input),
  products: (context, input) => purchaseProductsWorkflow(context, input),
  link: (context, input) => linkExpensesToPurchaseWorkflow(context, input),
  split: (context, input) => splitExpenseWorkflow(context, input),
  splitWithDelta: async (context, input) => {
    // Read before the split runs — the original row is soft-deleted by the
    // time `purchase.split` returns, so its cost has to be captured first.
    const original = await executeEntity(context, {
      action: "get",
      entity: "expense",
      id: input.expenseId,
      missing: "error",
    });
    if (original.action !== "get" || !original.item)
      throw new Error("Entity kernel returned the wrong expense detail");
    const items = await splitExpenseWorkflow(context, input);
    const { originalCost, partsSum, delta } = splitExpenseDelta(
      expenseOut.parse(original.item).cost,
      input.parts.map((part) => part.cost),
    );
    return { items, originalCost, partsSum, delta };
  },
  reclassifyDocument: (context, input) =>
    reclassifyPurchaseDocument(context.db, input, context.actorContext),
});
