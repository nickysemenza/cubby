import { unsafeWishShortcode, wishShortcode } from "@cubby/schemas/identifiers";
import {
  wishCreateInput,
  wishFiltersSchema,
  wishOut,
  wishSortableFields,
  wishUpdateData,
} from "@cubby/schemas/wish";
import { createAppError } from "~/server/errors/app-error";
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
    createInput: wishCreateInput,
    updateInput: wishUpdateData,
    output: wishOut,
    filters: wishFiltersSchema,
    sort: { sortableFields: wishSortableFields, defaultSort: "createdAt" },
    idSchema: wishShortcode,
  },
  repository: {
    getByID: async (ctx, id) => {
      const out = await getWishByShortcode(ctx.db, id);
      if (!out) throw createAppError("WISH_NOT_FOUND", `Wish not found: ${id}`);
      return out;
    },
    getByShortcode: (ctx, shortcode) => getWishByShortcode(ctx.db, shortcode),
    list: (ctx, filters, sorts, pagination) =>
      wishList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createWish(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateWish(
        ctx.db,
        { id: unsafeWishShortcode(id), data },
        ctx.actorContext,
      ),
    delete: async (ctx, ids) => {
      await deleteWishes(
        ctx.db,
        ids.map(unsafeWishShortcode),
        ctx.actorContext,
      );
      return [];
    },
  },
  entityName: "wish",
});

export const wishRouter = createTRPCRouter(procedures);
