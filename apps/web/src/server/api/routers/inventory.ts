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
import { findDuplicateUniqueProducts } from "~/server/repo/product";

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
    getByID: async (services, id) => {
      const res = await getInventoryEntryByID(services.db, id);
      if (res === null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Inventory entry not found",
        });
      }
      return res;
    },
    list: async (services, filters, sort, pagination) => {
      return await inventoryentryList(
        services.db,
        sort,
        pagination,
        filters.productNameFilter,
        filters.locationNameFilter,
        filters.locationIdFilter,
      );
    },
    create: async (services, data) => {
      // Check if this is a product with expectedQuantity=1 (unique item)
      const product = await services.db.product.findUnique({
        where: { id: data.productId },
        select: { expectedQuantity: true, name: true },
      });

      // If it's a unique item, check for duplicates
      if (product?.expectedQuantity === 1) {
        const existingEntry = await services.db.inventoryEntry.findFirst({
          where: {
            productId: data.productId,
            locationId: { not: data.locationId },
          },
          include: {
            location: { select: { name: true } },
          },
        });

        if (existingEntry) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `This unique item "${product.name}" is already inventoried at "${existingEntry.location.name}". Please update the existing entry instead of creating a duplicate.`,
          });
        }
      }

      return await createInventoryEntry(services.db, data);
    },
    update: async (services, id, data) => {
      return await updateInventoryEntry(services.db, id, data);
    },
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

// Find products with expectedQuantity=1 in multiple locations
const findDuplicates = publicProcedure
  .input(
    z.object({
      excludeLocationId: z.string().optional(),
    }),
  )
  .output(
    z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        manufacturer: z.string(),
        expectedQuantity: z.number().nullable(),
        locations: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
          }),
        ),
      }),
    ),
  )
  .query(async ({ ctx }) => {
    const duplicates = await findDuplicateUniqueProducts(ctx.db);

    return duplicates.map((product) => ({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      expectedQuantity: product.expectedQuantity,
      locations: product.InventoryEntry.map((entry) => ({
        id: entry.location.id,
        name: entry.location.name,
      })),
    }));
  });

export const inventoryentryRouter = createTRPCRouter({
  getByID,
  list,
  update,
  create,
  bulkProcess,
  findDuplicates,
});
