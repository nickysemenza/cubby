/**
 * Inventory Router - Direct repo access
 *
 * Inventory entries do not require external API enrichment (e.g., USDA),
 * so they call repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { type InventoryId, inventoryId } from "@cubby/schemas/identifiers";
import {
  bulkMovePayload,
  inventoryBulkOperationPayload,
  inventoryCreatePayloadData,
  inventoryFiltersSchema,
  inventoryFindDuplicatesInput,
  inventoryLocationIdsInput,
  inventoryUpdateInput,
} from "@cubby/schemas/inventory";
import {
  inventoryCountsByLocationOut,
  inventoryDuplicateUniqueProductsOut,
  inventoryListItemOut,
  inventoryWithLocationAndProductListOut,
  inventoryWithLocationAndProductOut,
} from "@cubby/schemas/inventory-responses";
import { createAppError } from "~/server/errors/app-error";
import {
  bulkMoveInventoryEntries,
  bulkProcessInventoryEntries,
  checkUniqueProductDuplicate,
  createInventoryEntry,
  deleteInventoryEntries,
  getInventoryByLocationIds,
  getInventoryCountsByLocations,
  getInventoryEntryByID,
  inventoryentryList,
  updateInventoryEntry,
} from "~/server/repo/inventory";
import { findDuplicateUniqueProducts } from "~/server/repo/product";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Create standardized CRUD procedures using factory
const { list } = createEntityListProcedure({
  schemas: {
    output: inventoryListItemOut,
    filters: inventoryFiltersSchema,
  },
  repository: {
    list: async (services, filters, sort, pagination) => {
      return await inventoryentryList(services.db, filters, sort, pagination);
    },
  },
  entityName: "inventory",
});

const { getByID, create, update } = createEntityCrudWithoutListProcedures({
  schemas: {
    createInput: inventoryCreatePayloadData,
    updateInput: inventoryUpdateInput.shape.data,
    output: inventoryWithLocationAndProductOut,
    idSchema: inventoryId,
  },
  repository: {
    getByID: async (services, id: InventoryId) => {
      const res = await getInventoryEntryByID(services.db, id);
      if (res === null) {
        throw createAppError(
          "INVENTORY_NOT_FOUND",
          "Inventory entry not found",
        );
      }
      return res;
    },
    create: async (services, data) => {
      // Check if this is a unique product that already exists elsewhere
      const duplicate = await checkUniqueProductDuplicate(
        services.db,
        data.productId,
        data.locationId,
      );

      if (duplicate) {
        throw createAppError(
          "PRODUCT_ALREADY_EXISTS",
          `This unique item "${duplicate.productName}" is already inventoried at "${duplicate.locationName}". Please update the existing entry instead of creating a duplicate.`,
        );
      }

      const created = await createInventoryEntry(
        services.db,
        data,
        services.actorContext,
      );
      // Eagerly refresh persisted location valuations (whole-tree).
      await services.services.locationValuation.recompute();
      return created;
    },
    update: async (services, id: InventoryId, data) => {
      const updated = await updateInventoryEntry(
        services.db,
        id,
        data,
        services.actorContext,
      );
      await services.services.locationValuation.recompute();
      return updated;
    },
  },
});

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<InventoryId>(async (services, ids) => {
  await deleteInventoryEntries(services.db, ids, services.actorContext);
  await services.services.locationValuation.recompute();
}, inventoryId);

// Bulk process inventory entries (creates and updates in one call)
const bulkProcess = protectedProcedure
  .input(inventoryBulkOperationPayload)
  .output(inventoryWithLocationAndProductListOut)
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
      ctx.actorContext,
    );
    await ctx.services.locationValuation.recompute();
    return result;
  });

// Bulk move inventory entries between locations
const bulkMove = protectedProcedure
  .input(bulkMovePayload)
  .output(inventoryWithLocationAndProductListOut)
  .mutation(async ({ ctx, input }) => {
    const result = await bulkMoveInventoryEntries(
      ctx.db,
      input,
      ctx.actorContext,
    );
    await ctx.services.locationValuation.recompute();
    return result;
  });

// Find products with expectedQuantity=1 in multiple locations
const findDuplicates = protectedProcedure
  .input(inventoryFindDuplicatesInput)
  .output(inventoryDuplicateUniqueProductsOut)
  .query(async ({ ctx }) => {
    const duplicates = await findDuplicateUniqueProducts(ctx.db);

    return duplicates.map((product) => ({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      expectedQuantity: product.expectedQuantity,
      locations: product.inventoryEntry.map((entry) => ({
        id: entry.location.id,
        name: entry.location.name,
      })),
    }));
  });

// Get inventory counts for multiple locations (batched query to avoid N+1)
const getCountsByLocations = protectedProcedure
  .input(inventoryLocationIdsInput)
  .output(inventoryCountsByLocationOut)
  .query(async ({ ctx, input }) => {
    return await getInventoryCountsByLocations(ctx.db, input.locationIds);
  });

// Get inventory entries for multiple locations (batched query to avoid N+1)
const getByLocationIds = protectedProcedure
  .input(inventoryLocationIdsInput)
  .output(inventoryWithLocationAndProductListOut)
  .query(async ({ ctx, input }) => {
    return await getInventoryByLocationIds(ctx.db, input.locationIds);
  });

export const inventoryRouter = createTRPCRouter({
  getByID,
  list,
  update,
  create,
  delete: deleteItem,
  bulkProcess,
  bulkMove,
  findDuplicates,
  getCountsByLocations,
  getByLocationIds,
});
