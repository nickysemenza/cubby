import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";

import {
  createWish,
  deleteWishes,
  getWishByShortcode,
  updateWish,
  WISH_DELETE_EDGE_POLICY,
  wishList,
} from "./wish";

export const wishEntityAdapter = defineEntityAdapter({
  entity: "wish",
  lifecycle: { delete: WISH_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getWishByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      wishList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createWish(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) => updateWish(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      await deleteWishes(ctx.db, ids, ctx.actorContext);
      return { deletedReferences: entityMutationReferences("wish", ids) };
    },
  },
});
