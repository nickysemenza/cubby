import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import {
  createPaginatedResponseSchema,
  IDInput,
  sortPaginationCombo,
  buildPaginatedResponse,
} from "~/schemas/util";
import {
  getInventoryEntryByID,
  inventoryentryList,
  updateInventoryEntry,
  type UpdateInventoryEntryData,
  createInventoryEntry,
} from "~/server/repo/inventory";
import { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { TRPCError } from "@trpc/server";
import {
  inventoryCreatePayloadData,
  inventoryUpdatePayloadData,
} from "~/schemas/inventory";

const getByID = publicProcedure
  .input(IDInput)
  .output(inventoryWithLocationAndProductOut)
  .query(async ({ ctx, input }) => {
    const res = await getInventoryEntryByID(ctx.db, input.id);
    if (res === null) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Inventory entry not found",
      });
    }
    return res;
  });

const list = publicProcedure
  .input(
    z
      .object({
        // no filters yet
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(inventoryWithLocationAndProductOut))
  .query(async ({ ctx, input }) => {
    const { data, count } = await inventoryentryList(
      ctx.db,
      input.sort,
      input.pagination,
    );
    return buildPaginatedResponse(input.pagination, data, count);
  });

const update = publicProcedure
  .input(
    z.object({
      id: z.string().uuid(),
      data: inventoryUpdatePayloadData,
    }),
  )
  .output(inventoryWithLocationAndProductOut)
  .mutation(async ({ ctx, input }) => {
    try {
      const result = await updateInventoryEntry(
        ctx.db,
        input.id,
        input.data as UpdateInventoryEntryData,
      );
      return result;
    } catch (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to update inventory entry",
        cause: error,
      });
    }
  });

const create = publicProcedure
  .input(inventoryCreatePayloadData)
  .output(inventoryWithLocationAndProductOut)
  .mutation(async ({ ctx, input }) => {
    try {
      const result = await createInventoryEntry(ctx.db, input);
      return result;
    } catch (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create inventory entry",
        cause: error,
      });
    }
  });

export const inventoryentryRouter = createTRPCRouter({
  getByID,
  list,
  update,
  create,
});
