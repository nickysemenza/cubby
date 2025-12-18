import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  createAppError,
  requireActorContext,
} from "../trpc";
import {
  getInventoryEntryByID,
  inventoryentryList,
  updateInventoryEntry,
  createInventoryEntry,
  bulkProcessInventoryEntries,
  bulkMoveInventoryEntries,
  checkUniqueProductDuplicate,
  exportInventoryToCSV,
  importInventoryFromCSV,
  deleteInventoryEntry,
} from "~/server/repo/inventory";
import { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import {
  inventoryCreatePayloadData,
  inventoryBulkOperationPayload,
  inventoryUpdateInput,
  bulkMovePayload,
  inventoryCSVImportPayload,
  csvImportResult,
} from "~/schemas/inventory";
import { createEntityCrudProcedures } from "../crud-factory";
import { findDuplicateUniqueProducts } from "~/server/repo/product";
import {
  inventoryId,
  locationId,
  unsafeProductId,
  type InventoryId,
} from "~/schemas/identifiers";
import { importImageFromUPC } from "~/server/services/image-import";

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
        throw createAppError(
          "INVENTORY_NOT_FOUND",
          "Inventory entry not found",
        );
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
        throw createAppError(
          "PRODUCT_ALREADY_EXISTS",
          `This unique item "${duplicate.productName}" is already inventoried at "${duplicate.locationName}". Please update the existing entry instead of creating a duplicate.`,
        );
      }

      // organizationId guaranteed non-null by requireOrganization middleware
      const actor = requireActorContext(services);
      return await createInventoryEntry(services.db, data, actor);
    },
    update: async (services, id: InventoryId, data) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      const actor = requireActorContext(services);
      return await updateInventoryEntry(services.db, id, data, actor);
    },
  },
  entityName: "inventory-item",
});

// Bulk process inventory entries (creates and updates in one call)
const bulkProcess = protectedProcedure
  .input(inventoryBulkOperationPayload)
  .output(z.array(inventoryWithLocationAndProductOut))
  .mutation(async ({ ctx, input }) => {
    const actor = requireActorContext(ctx);
    const result = await bulkProcessInventoryEntries(
      ctx.db,
      input.locationId,
      input.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        locationId: item.locationId ?? input.locationId,
        amount: item.amount,
      })),
      actor,
    );
    return result;
  });

// Bulk move inventory entries between locations
const bulkMove = protectedProcedure
  .input(bulkMovePayload)
  .output(z.array(inventoryWithLocationAndProductOut))
  .mutation(async ({ ctx, input }) => {
    const actor = requireActorContext(ctx);
    return await bulkMoveInventoryEntries(ctx.db, input, actor);
  });

// Delete a single inventory entry
const deleteItem = protectedProcedure
  .input(z.object({ id: inventoryId }))
  .output(z.void())
  .mutation(async ({ ctx, input }) => {
    const actor = requireActorContext(ctx);
    await deleteInventoryEntry(ctx.db, input.id, actor);
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

// Export inventory to CSV format
const exportCSV = protectedProcedure
  .input(
    z.object({
      locationId: locationId.optional(),
    }),
  )
  .output(
    z.array(
      z.object({
        product_name: z.string(),
        manufacturer: z.string(),
        upc: z.string(),
        location_path: z.string(),
        quantity: z.number(),
        unit: z.string(),
        expected_qty: z.number().nullable(),
        price: z.number().nullable(),
        unit_mappings: z.string().nullable(),
        ingredient_name: z.string().nullable(),
      }),
    ),
  )
  .query(async ({ ctx, input }) => {
    return await exportInventoryToCSV(
      ctx.db,
      ctx.organizationId,
      input.locationId,
    );
  });

// Import inventory from CSV data
const importCSV = protectedProcedure
  .input(inventoryCSVImportPayload)
  .output(csvImportResult)
  .mutation(async ({ ctx, input }) => {
    const actor = requireActorContext(ctx);
    const result = await importInventoryFromCSV(
      ctx.db,
      actor.organizationId,
      input.rows,
      {
        dryRun: false,
        actor: { ...actor, source: "csv_import" },
      },
    );

    // Import images for newly created products with UPC codes (non-blocking)
    // We do this after the main import to avoid slowing down the CSV import
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
            actor.organizationId,
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

// Preview what CSV import would do (dry run)
const previewCSVImport = protectedProcedure
  .input(inventoryCSVImportPayload)
  .output(csvImportResult)
  .mutation(async ({ ctx, input }) => {
    const actor = requireActorContext(ctx);
    return await importInventoryFromCSV(
      ctx.db,
      actor.organizationId,
      input.rows,
      {
        dryRun: true,
        actor: { ...actor, source: "csv_import" },
      },
    );
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
  exportCSV,
  importCSV,
  previewCSVImport,
});
