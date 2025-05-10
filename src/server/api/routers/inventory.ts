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
  createInventoryEntry,
  bulkProcessInventoryEntries,
} from "~/server/repo/inventory";
import { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { TRPCError } from "@trpc/server";
import {
  inventoryCreatePayloadData,
  inventoryBulkOperationPayload,
  inventoryUpdateInput,
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
        filters: z.object({
          productNameFilter: z.string().optional(),
          locationNameFilter: z.string().optional(),
          locationIdFilter: z.string().optional(),
        }),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(inventoryWithLocationAndProductOut))
  .query(async ({ ctx, input }) => {
    const { data, count } = await inventoryentryList(
      ctx.db,
      input.sort,
      input.pagination,
      input.filters.productNameFilter,
      input.filters.locationNameFilter,
      input.filters.locationIdFilter,
    );
    return buildPaginatedResponse(input.pagination, data, count);
  });

const update = publicProcedure
  .input(inventoryUpdateInput)
  .output(inventoryWithLocationAndProductOut)
  .mutation(async ({ ctx, input }) => {
    try {
      const result = await updateInventoryEntry(ctx.db, input.id, input.data);
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

// Bulk process inventory entries (creates and updates in one call)
const bulkProcess = publicProcedure
  .input(inventoryBulkOperationPayload)
  .output(z.array(inventoryWithLocationAndProductOut))
  .mutation(async ({ ctx, input }) => {
    console.log({ input });
    const result = await bulkProcessInventoryEntries(
      ctx.db,
      input.locationId,
      input.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        locationId: item.locationId ?? input.locationId,
        amount: item.amount,
      })),
    );
    return result;
  });

export const inventoryentryRouter = createTRPCRouter({
  getByID,
  list,
  update,
  create,
  bulkProcess,
});
