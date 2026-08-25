import { wishFiltersSchema, wishSortableFields } from "@cubby/schemas/wish";
import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
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
  filters: wishFiltersSchema,
  sort: { fields: wishSortableFields, default: "createdAt" },
  lifecycle: { delete: WISH_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getWishByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      wishList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createWish(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) => updateWish(ctx.db, id, data, ctx.actorContext),
    delete: (ctx, ids) => deleteWishes(ctx.db, ids, ctx.actorContext),
  },
});
