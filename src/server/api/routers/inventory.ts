import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
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
import { createEntityCrudProcedures } from "../crud-factory";

// Define filters schema for inventory entries
const inventoryFiltersSchema = z.object({
  productNameFilter: z.string().optional(),
  locationNameFilter: z.string().optional(),
  locationIdFilter: z.string().optional(),
});

// Create standardized CRUD procedures using factory
const { getByID, list, create, update } = createEntityCrudProcedures({
  schemas: {
    createInput: inventoryCreatePayloadData,
    updateInput: inventoryUpdateInput.shape.data,
    output: inventoryWithLocationAndProductOut,
    filters: inventoryFiltersSchema,
  },
  repository: {
    getByID: async (db, id) => {
      const res = await getInventoryEntryByID(db, id);
      if (res === null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Inventory entry not found",
        });
      }
      return res;
    },
    list: async (db, filters, sort, pagination) => {
      return await inventoryentryList(
        db,
        sort,
        pagination,
        filters.productNameFilter,
        filters.locationNameFilter,
        filters.locationIdFilter,
      );
    },
    create: createInventoryEntry,
    update: updateInventoryEntry,
  },
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
