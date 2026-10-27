import {
  mergePurchasesInput,
  mergePurchasesOut,
} from "@cubby/schemas/purchase";
import { rawPurchaseOut } from "@cubby/schemas/purchase-raw-read";

import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { recordChange } from "~/server/generic/changes/repo/change";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createPurchase,
  deletePurchases,
  mergePurchases,
  PURCHASE_DELETE_EDGE_POLICY,
  PURCHASE_MERGE_EDGE_POLICY,
  purchaseScaffold,
  updatePurchase,
} from "./purchase";

const purchaseShortcodes = bindShortcodeResolver("purchase");

export const purchaseRepository = defineRepository("purchase", {
  lifecycle: {
    delete: PURCHASE_DELETE_EDGE_POLICY,
    merge: PURCHASE_MERGE_EDGE_POLICY,
  },
  scaffold: purchaseScaffold,
  create: asActor(createPurchase),
  update: (ctx, id, data) => updatePurchase(ctx.db, id, data, ctx.actorContext),
  updateRead: (ctx, id, data, fields) =>
    updatePurchase.read(fields, ctx.db, id, data, ctx.actorContext),
  // The detached expenses and transactions re-project without the purchase.
  delete: async (ctx, ids) => {
    const detached = await deletePurchases(ctx.db, ids, ctx.actorContext);
    await recordChange(ctx.db, {
      kind: "source",
      categories: ["expense", "financialTransaction"],
    });
    return detached;
  },
  merge: {
    input: mergePurchasesInput,
    output: mergePurchasesOut.extend({ purchase: rawPurchaseOut }),
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
