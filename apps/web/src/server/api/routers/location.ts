/**
 * Location Router - Direct repo access
 *
 * This entity does not require external API enrichment (e.g., USDA),
 * so it calls repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { z } from "zod";
import { protectedProcedure, createTRPCRouter } from "../trpc";
import {
  infLocation,
  locationType,
  locationCreateInput,
  locationUpdateInput,
  locationCSVRow,
  locationCSVImportResult,
} from "~/schemas/location";
import {
  buildLocationTree,
  buildLocationTypeCount,
  getLocationById,
  locationList,
  createLocation,
  updateLocation,
} from "~/server/repo/location";
import { exportLocationsToCSV } from "~/server/repo/location/csv-export";
import { importLocationsFromCSV } from "~/server/repo/location/csv-import";
import { locationOutWithParentChildrenAndInventoryOut } from "~/schemas/combo";
import {
  createEntityListProcedure,
  createEntityCrudWithoutListProcedures,
} from "../crud-factory";
import { locationId, type LocationId } from "~/schemas/identifiers";

// Define filters schema for locations
const locationFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  itemTypeFilter: locationType.optional(),
});

// Create standardized list procedure using factory
const { list } = createEntityListProcedure({
  schemas: {
    output: locationOutWithParentChildrenAndInventoryOut,
    filters: locationFiltersSchema,
  },
  repository: {
    list: async (services, filters, sort, pagination) => {
      return await locationList(
        services.db,
        services.organizationId,
        filters.nameFilter,
        filters.itemTypeFilter,
        sort,
        pagination,
      );
    },
  },
  entityName: "location",
});

// Create standardized getByID, create, update procedures using factory
const { getByID, create, update } = createEntityCrudWithoutListProcedures({
  schemas: {
    createInput: locationCreateInput,
    updateInput: locationUpdateInput.shape.data,
    output: infLocation,
    idSchema: locationId,
  },
  repository: {
    getByID: async (services, id: LocationId) => {
      return await getLocationById(services.db, id, services.organizationId);
    },
    create: async (services, data) => {
      return await createLocation(services.db, data, services.actorContext);
    },
    update: async (services, id: LocationId, data) => {
      return await updateLocation(services.db, id, data, services.actorContext);
    },
  },
});

const getLocationTypesCount = protectedProcedure
  .output(z.record(locationType, z.number()))
  .query(async ({ ctx }) => {
    return await buildLocationTypeCount(ctx.db, ctx.organizationId);
  });

const makeTree = protectedProcedure
  .output(z.array(infLocation))
  .query(
    async ({ ctx }) => await buildLocationTree(ctx.db, ctx.organizationId),
  );

// Export locations to CSV format
const exportCSV = protectedProcedure
  .output(
    z.array(
      z.object({
        location_name: z.string(),
        parent_name: z.string().nullable(),
        location_type: locationType,
        description: z.string().nullable(),
        location_image: z.string().nullable(),
      }),
    ),
  )
  .query(async ({ ctx }) => {
    const rows = await exportLocationsToCSV(ctx.db, ctx.organizationId);
    // Return without internal location_id field
    return rows.map(({ location_id: _id, ...rest }) => rest);
  });

// Import locations from CSV data
const importCSV = protectedProcedure
  .input(z.object({ rows: z.array(locationCSVRow) }))
  .output(locationCSVImportResult)
  .mutation(async ({ ctx, input }) => {
    return await importLocationsFromCSV(
      ctx.db,
      ctx.organizationId,
      input.rows,
      { dryRun: false },
    );
  });

// Preview what CSV import would do (dry run)
const previewCSVImport = protectedProcedure
  .input(z.object({ rows: z.array(locationCSVRow) }))
  .output(locationCSVImportResult)
  .mutation(async ({ ctx, input }) => {
    return await importLocationsFromCSV(
      ctx.db,
      ctx.organizationId,
      input.rows,
      { dryRun: true },
    );
  });

export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getLocationTypesCount,
  makeTree,
  create,
  update,
  exportCSV,
  importCSV,
  previewCSVImport,
});
