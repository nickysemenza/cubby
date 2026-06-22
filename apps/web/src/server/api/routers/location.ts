/**
 * Location Router - Direct repo access
 *
 * This entity does not require external API enrichment (e.g., USDA),
 * so it calls repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { locationOutWithParentChildrenAndInventoryOut } from "@cubby/schemas/combo";
import { type LocationId, locationId } from "@cubby/schemas/identifiers";
import {
  infLocation,
  locationCreateInput,
  locationFiltersSchema,
  locationOut,
  locationType,
  locationUpdateInput,
} from "@cubby/schemas/location";
import { z } from "zod";
import {
  buildLocationTree,
  buildLocationTypeCount,
  createLocation,
  deleteLocations,
  getChildCountsByLocationIds,
  getLocationById,
  getLocationByShortcode,
  getLocationsByShortcodes,
  getRecentlyActiveLocations,
  locationList,
  touchLastBulkInventory as touchLastBulkInventoryRepo,
  updateLocation,
} from "~/server/repo/location";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Create standardized list procedure using factory
const { list } = createEntityListProcedure({
  schemas: {
    output: locationOutWithParentChildrenAndInventoryOut,
    filters: locationFiltersSchema,
  },
  repository: {
    list: async (services, filters, sort, pagination, groupBy) => {
      return await locationList(
        services.db,
        filters,
        sort,
        pagination,
        groupBy,
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
      return await getLocationById(services.db, id);
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
    return await buildLocationTypeCount(ctx.db);
  });

const makeTree = protectedProcedure
  .output(z.array(infLocation))
  .query(async ({ ctx }) => await buildLocationTree(ctx.db));

// Touch lastBulkInventory timestamp (for Scanner page "Mark Complete" button)
const touchLastBulkInventory = protectedProcedure
  .input(z.object({ id: locationId }))
  .output(z.object({ success: z.boolean() }))
  .mutation(async ({ ctx, input }) => {
    await touchLastBulkInventoryRepo(ctx.db, input.id);
    return { success: true };
  });

// Batch lookup: multiple locations by shortcode (e.g. for label printing)
const getByShortcodes = protectedProcedure
  .input(z.object({ shortcodes: z.array(z.string()) }))
  .output(z.array(locationOut.extend({ parentName: z.string().nullable() })))
  .query(async ({ ctx, input }) => {
    return await getLocationsByShortcodes(ctx.db, input.shortcodes);
  });

// Get location by shortcode (e.g., L-A3F2)
const getByShortcode = protectedProcedure
  .input(z.object({ shortcode: z.string() }))
  .output(infLocation.nullable())
  .query(async ({ ctx, input }) => {
    return await getLocationByShortcode(ctx.db, input.shortcode);
  });

// Get recently active locations for scanner quick-select
const getRecentlyActive = protectedProcedure
  .input(z.object({ limit: z.number().min(1).max(10).default(5) }).optional())
  .output(z.array(locationOut))
  .query(async ({ ctx, input }) => {
    return await getRecentlyActiveLocations(ctx.db, input?.limit ?? 5);
  });

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<LocationId>(async (services, ids) => {
  await deleteLocations(services.db, ids, services.actorContext);
}, locationId);

// Get child location counts for multiple parent locations (batched to avoid N+1)
const getChildCountsByLocations = protectedProcedure
  .input(z.object({ locationIds: z.array(locationId) }))
  .output(z.record(z.string(), z.number()))
  .query(async ({ ctx, input }) => {
    return await getChildCountsByLocationIds(ctx.db, input.locationIds);
  });

export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getByShortcode,
  getByShortcodes,
  getRecentlyActive,
  getLocationTypesCount,
  getChildCountsByLocations,
  makeTree,
  create,
  update,
  delete: deleteItem,
  touchLastBulkInventory,
});
