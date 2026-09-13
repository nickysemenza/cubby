import {
  mergePurchasesInput,
  mergePurchasesOut,
} from "@cubby/schemas/purchase";

import {
  defineEntityAdapter,
  deletedWithImages,
} from "~/server/entity-kernel/adapter";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";

import {
  createPurchase,
  deletePurchases,
  getPurchaseByShortcode,
  mergePurchases,
  PURCHASE_DELETE_EDGE_POLICY,
  PURCHASE_MERGE_EDGE_POLICY,
  purchaseList,
  updatePurchase,
} from "./purchase";

const purchaseShortcodes = bindShortcodeResolver("purchase");

export const purchaseEntityAdapter = defineEntityAdapter({
  entity: "purchase",
  lifecycle: {
    delete: PURCHASE_DELETE_EDGE_POLICY,
    merge: PURCHASE_MERGE_EDGE_POLICY,
  },
  repository: {
    get: (ctx, id) => getPurchaseByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      purchaseList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createPurchase(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updatePurchase(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      const detached = await deletePurchases(ctx.db, ids, ctx.actorContext);
      await runMutationSideEffectsForEntities(ctx.db, [
        ...mutationEvents(
          "expense",
          "updated",
          detached.expenseIds,
          "purchase.delete",
        ),
        ...mutationEvents(
          "financialTransaction",
          "updated",
          detached.financialTransactionIds,
          "purchase.delete",
        ),
      ]);
      return {
        deletedReferences: deletedWithImages(
          "purchase",
          ids,
          detached.deletedImageShortcodes,
        ),
        detachedImageKeys: detached.detachedImageKeys,
      };
    },
  },
  merge: {
    input: mergePurchasesInput,
    output: mergePurchasesOut,
    item: (output) => output.purchase,
    summary: (output) => output.mergeSummary,
    execute: async (ctx, input) => {
      const output = await mergePurchases(ctx.db, input, ctx.actorContext);
      return {
        output,
        entityId: await purchaseShortcodes.one(ctx.db, output.purchase.id),
        detachedImageKeys: [],
      };
    },
  },
});
