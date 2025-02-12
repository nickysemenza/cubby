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
} from "~/server/repo/inventory";
import { inventoryWithLocationAndProductOut } from "~/schemas/combo";

const getByID = publicProcedure
  .input(IDInput)
  .output(inventoryWithLocationAndProductOut)
  .query(
    async ({ ctx, input }) => await getInventoryEntryByID(ctx.db, input.id),
  );

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

export const inventoryentryRouter = createTRPCRouter({
  getByID,
  list,
});
