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
  locationType,
  locationUpdateInput,
} from "~/schemas/location";
import {
  buildLocationTree,
  buildLocationTypeCount,
  createLocation,
  getLocationById,
  locationList,
  touchLastBulkInventory as touchLastBulkInventoryRepo,
  updateLocation,
} from "~/server/repo/location";
import {
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

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
      return await locationList(services.db, filters, sort, pagination);
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

export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getLocationTypesCount,
  makeTree,
  create,
  update,
  touchLastBulkInventory,
});
