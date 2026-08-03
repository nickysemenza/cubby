import { unsafeWishId, wishShortcode } from "@cubby/schemas/identifiers";
import {
  wishCreateInput,
  wishFiltersSchema,
  wishOut,
  wishSortableFields,
  wishUpdateInput,
} from "@cubby/schemas/wish";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  createWish,
  deleteWishes,
  getWishByID,
  getWishByShortcode,
  updateWish,
  wishList,
} from "~/server/repo/wish";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import {
  createEntityListProcedure,
  createGetByShortcodeProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const { list } = createEntityListProcedure({
  schemas: {
    output: wishOut,
    filters: wishFiltersSchema,
    sort: { sortableFields: wishSortableFields, defaultSort: "createdAt" },
  },
  repository: {
    list: (ctx, filters, sorts, pagination) =>
      wishList(ctx.db, filters, sorts, pagination),
  },
  entityName: "wish",
});

const getByID = protectedProcedure
  .input(wishShortcode)
  .output(strictOutput(wishOut))
  .query(async ({ ctx, input }) => {
    const id = await resolveLiveShortcode(ctx.db, input, "wish");
    if (!id) throw createAppError("WISH_NOT_FOUND", `Wish not found: ${input}`);
    return getWishByID(ctx.db, unsafeWishId(id));
  });

const getByShortcode = createGetByShortcodeProcedure(
  "wish",
  wishOut,
  (ctx, shortcode) => getWishByShortcode(ctx.db, shortcode),
);

const create = protectedProcedure
  .input(wishCreateInput)
  .output(strictOutput(wishOut))
  .mutation(async ({ ctx, input }) => {
    const result = await createWish(ctx.db, input, ctx.actorContext);
    await runMutationSideEffects(ctx.db, {
      action: "created",
      entity: { entityType: "wish", entityId: result.entityId },
      source: "wish.create",
    });
    return result.output;
  });

const update = protectedProcedure
  .input(wishUpdateInput)
  .output(strictOutput(wishOut))
  .mutation(async ({ ctx, input }) => {
    const result = await updateWish(ctx.db, input, ctx.actorContext);
    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "wish", entityId: result.entityId },
      source: "wish.update",
    });
    return result.output;
  });

const deleteItem = protectedProcedure
  .input(z.object({ ids: z.array(wishShortcode).min(1).max(500) }))
  .mutation(async ({ ctx, input }) => {
    await deleteWishes(ctx.db, input.ids, ctx.actorContext);
  });

export const wishRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  list,
  create,
  update,
  delete: deleteItem,
});
