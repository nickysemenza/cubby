import {
  mergePurchasesInput,
  mergePurchasesOut,
} from "@cubby/schemas/purchase";

import {
  asActor,
  defineRepository,
  listOn,
  onDb,
} from "~/server/repo/repository";
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

export const purchaseRepository = defineRepository("purchase", {
  lifecycle: {
    delete: PURCHASE_DELETE_EDGE_POLICY,
    merge: PURCHASE_MERGE_EDGE_POLICY,
  },
  get: onDb(getPurchaseByShortcode),
  list: listOn(purchaseList),
  create: asActor(createPurchase),
  update: asActor(updatePurchase),
  // The detached expenses and transactions re-project without the purchase.
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
    return detached;
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
