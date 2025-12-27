/**
 * Location Router - Direct repo access
 *
 * This entity does not require external API enrichment (e.g., USDA),
 * so it calls repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { z } from "zod";
import { locationOutWithParentChildrenAndInventoryOut } from "~/schemas/combo";
import { type LocationId, locationId } from "~/schemas/identifiers";
import {
  infLocation,
  locationCreateInput,
  locationCSVImportResult,
  locationCSVRow,
  locationType,
  locationUpdateInput,
} from "~/schemas/location";
import {
  buildLocationTree,
  buildLocationTypeCount,
  createLocation,
  getLocationById,
  locationList,
  updateLocation,
} from "~/server/repo/location";
import { exportLocationsToCSV } from "~/server/repo/location/csv-export";
import { importLocationsFromCSV } from "~/server/repo/location/csv-import";
import {
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createCSVProcedures } from "../csv-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Schema for location CSV export (without internal location_id field)
const locationCSVExportRow = z.object({
  location_name: z.string(),
  parent_name: z.string().nullable(),
  location_type: locationType,
  description: z.string().nullable(),
  location_image: z.string().nullable(),
});

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
        filters,
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

// CSV import/export procedures using factory
const { exportCSV, importCSV, previewCSVImport } = createCSVProcedures({
  schemas: {
    importRow: locationCSVRow,
    importResult: locationCSVImportResult,
    exportRow: locationCSVExportRow,
  },
  repo: {
    import: (ctx, rows, dryRun) =>
      importLocationsFromCSV(ctx.db, ctx.organizationId, rows, { dryRun }),
    export: async (ctx) => {
      const rows = await exportLocationsToCSV(ctx.db, ctx.organizationId);
      // Strip internal location_id field
      return rows.map(({ location_id: _id, ...rest }) => rest);
    },
  },
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
