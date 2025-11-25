import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  getInventoryEntryByID,
  inventoryentryList,
  updateInventoryEntry,
  createInventoryEntry,
  bulkProcessInventoryEntries,
  checkUniqueProductDuplicate,
} from "~/server/repo/inventory";
import { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { TRPCError } from "@trpc/server";
import {
  inventoryCreatePayloadData,
  inventoryBulkOperationPayload,
  inventoryUpdateInput,
} from "~/schemas/inventory";
import { createEntityCrudProcedures } from "../crud-factory";
import { AppErrorReason } from "~/lib/app-error-codes";
import { findDuplicateUniqueProducts } from "~/server/repo/product";
import { inventoryId, type InventoryId } from "~/schemas/identifiers";

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
    idSchema: inventoryId,
  },
  repository: {
    getByID: async (services, id: InventoryId) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      const res = await getInventoryEntryByID(
        services.db,
        id,
        services.organizationId!,
      );
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
        services.organizationId!,
        sort,
        pagination,
        filters.productNameFilter,
        filters.locationNameFilter,
        filters.locationIdFilter,
      );
    },
    create: async (services, data) => {
      // Check if this is a unique product that already exists elsewhere
      const duplicate = await checkUniqueProductDuplicate(
        services.db,
        data.productId,
        data.locationId,
      );

      if (duplicate) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `This unique item "${duplicate.productName}" is already inventoried at "${duplicate.locationName}". Please update the existing entry instead of creating a duplicate.`,
          cause: { reason: AppErrorReason.PRODUCT_ALREADY_EXISTS },
        });
      }

      // organizationId guaranteed non-null by requireOrganization middleware
      return await createInventoryEntry(
        services.db,
        data,
        services.organizationId!,
      );
    },
    update: async (services, id: InventoryId, data) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await updateInventoryEntry(
        services.db,
        id,
        services.organizationId!,
        data,
      );
    },
  },
});

// Bulk process inventory entries (creates and updates in one call)
const bulkProcess = protectedProcedure
  .input(inventoryBulkOperationPayload)
  .output(z.array(inventoryWithLocationAndProductOut))
  .mutation(async ({ ctx, input }) => {
    const result = await bulkProcessInventoryEntries(
      ctx.db,
      input.locationId,
      input.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        locationId: item.locationId ?? input.locationId,
        amount: item.amount,
      })),
      ctx.organizationId,
    );
    return result;
  });

// Find products with expectedQuantity=1 in multiple locations
const findDuplicates = protectedProcedure
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
    const duplicates = await findDuplicateUniqueProducts(
      ctx.db,
      ctx.organizationId,
    );

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

export const inventoryRouter = createTRPCRouter({
  getByID,
  list,
  update,
  create,
  bulkProcess,
  findDuplicates,
});
