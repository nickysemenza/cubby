/**
 * Inventory Router - Direct repo access
 *
 * Inventory entries do not require external API enrichment (e.g., USDA),
 * so they call repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { z } from "zod";
import { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import {
  type InventoryId,
  inventoryId,
  unsafeProductId,
} from "~/schemas/identifiers";
import {
  bulkMovePayload,
  csvImportResult,
  inventoryBulkOperationPayload,
  inventoryCreatePayloadData,
  inventoryCSVRow,
  inventoryUpdateInput,
} from "~/schemas/inventory";
import {
  backfillInventoryValuations,
  bulkMoveInventoryEntries,
  bulkProcessInventoryEntries,
  checkUniqueProductDuplicate,
  createInventoryEntry,
  deleteInventoryEntries,
  findInventoryWithStaleValuations,
  getInventoryCountsByLocations,
  getInventoryEntryByID,
  importInventoryFromCSV,
  inventoryentryList,
  updateInventoryEntry,
} from "~/server/repo/inventory";
import { findDuplicateUniqueProducts } from "~/server/repo/product";
import { importImageFromUPC } from "~/server/services/image-import";
import {
  createDeleteProcedure,
  createEntityCrudProcedures,
} from "../crud-factory";
import { createAppError, createTRPCRouter, protectedProcedure } from "../trpc";

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
      const res = await getInventoryEntryByID(services.db, id);
      if (res === null) {
        throw createAppError(
          "INVENTORY_NOT_FOUND",
          "Inventory entry not found",
        );
      }
      return res;
    },
    list: async (services, filters, sort, pagination) => {
      return await inventoryentryList(services.db, filters, sort, pagination);
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

      return await createInventoryEntry(
        services.db,
        data,
        services.actorContext,
      );
    },
    update: async (services, id: InventoryId, data) => {
      return await updateInventoryEntry(
        services.db,
        id,
        data,
        services.actorContext,
      );
    },
  },
  entityName: "inventory",
});

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<InventoryId>(async (services, ids) => {
  await deleteInventoryEntries(services.db, ids, services.actorContext);
}, inventoryId);

// Bulk process inventory entries (creates and updates in one call)
const bulkProcess = protectedProcedure
  .input(inventoryBulkOperationPayload)
  .output(z.array(inventoryWithLocationAndProductOut))
  .mutation(async ({ ctx, input }) => {
    return await bulkProcessInventoryEntries(
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
  });

// Bulk move inventory entries between locations
const bulkMove = protectedProcedure
  .input(bulkMovePayload)
  .output(z.array(inventoryWithLocationAndProductOut))
  .mutation(async ({ ctx, input }) => {
    return await bulkMoveInventoryEntries(ctx.db, input, ctx.actorContext);
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

// CSV import procedure (used by scripts/load-data.ts)
const importCSV = protectedProcedure
  .input(z.object({ rows: z.array(inventoryCSVRow) }))
  .output(csvImportResult)
  .mutation(async ({ ctx, input }) => {
    const result = await importInventoryFromCSV(ctx.db, input.rows, {
      dryRun: false,
      actor: { ...ctx.actorContext, source: "csv_import" },
    });

    // Import UPC images for newly created products after successful import
    const productsToImportImages = result.items.filter(
      (item) =>
        item.productId &&
        item.upc &&
        (item.action === "created" || item.action === "product_only"),
    );

    // Process image imports in parallel but don't block on failures
    await Promise.allSettled(
      productsToImportImages.map(async (item) => {
        try {
          await importImageFromUPC(
            ctx.db,
            ctx.upcLookupClient,
            item.upc!,
            unsafeProductId(item.productId!),
          );
        } catch (error) {
          console.error(
            `[importCSV] Image import failed for UPC ${item.upc}:`,
            error,
          );
        }
      }),
    );

    return result;
  });

// Get count of inventory entries with stale/missing valuations
const getStaleValuationsCount = protectedProcedure
  .output(z.number())
  .query(async ({ ctx }) => {
    const staleEntries = await findInventoryWithStaleValuations(ctx.db);
    return staleEntries.length;
  });

// Backfill inventory valuations from product prices
const backfillInventoryValuationsEndpoint = protectedProcedure
  .output(
    z.object({
      updated: z.number(),
      skipped: z.number(),
    }),
  )
  .mutation(async ({ ctx }) => {
    return await backfillInventoryValuations(ctx.db);
  });

// Get inventory counts for multiple locations (batched query to avoid N+1)
const getCountsByLocations = protectedProcedure
  .input(z.object({ locationIds: z.array(z.string()) }))
  .output(z.record(z.string(), z.number()))
  .query(async ({ ctx, input }) => {
    return await getInventoryCountsByLocations(ctx.db, input.locationIds);
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
  importCSV,
  getStaleValuationsCount,
  backfillInventoryValuations: backfillInventoryValuationsEndpoint,
  getCountsByLocations,
});
