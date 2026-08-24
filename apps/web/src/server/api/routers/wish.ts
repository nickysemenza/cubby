import { wishFiltersSchema, wishSortableFields } from "@cubby/schemas/wish";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import {
  createWish,
  deleteWishes,
  getWishByShortcode,
  updateWish,
  wishList,
} from "~/server/repo/wish";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter } from "../trpc";

const procedures = createSearchableEntityCrudProcedures({
  schemas: {
    ...ENTITY_BINDINGS.wish.crud,
    filters: wishFiltersSchema,
    sort: { sortableFields: wishSortableFields, defaultSort: "createdAt" },
  },
  repository: {
    getByShortcode: (ctx, shortcode) => getWishByShortcode(ctx.db, shortcode),
    list: (ctx, filters, sorts, pagination) =>
      wishList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createWish(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) => updateWish(ctx.db, id, data, ctx.actorContext),
    delete: (ctx, ids) => deleteWishes(ctx.db, ids, ctx.actorContext),
  },
  entityName: "wish",
});

export const wishRouter = createTRPCRouter(procedures);
