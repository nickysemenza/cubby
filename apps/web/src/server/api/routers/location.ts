import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, createTRPCRouter } from "../trpc";
import {
  infLocation,
  locationType,
  locationCreateInput,
  locationUpdateInput,
} from "~/schemas/location";
import {
  buildLocationTree,
  buildLocationTypeCount,
  getLocationById,
  locationList,
  createLocation,
  updateLocation,
} from "~/server/repo/location";
import { locationOutWithParentChildrenAndInventoryOut } from "~/schemas/combo";
import {
  createEntityListProcedure,
  createEntityCrudWithoutListProcedures,
} from "../crud-factory";

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
        services.projectId,
        filters.nameFilter,
        filters.itemTypeFilter,
        sort,
        pagination,
      );
    },
  },
});

// Create standardized getByID, create, update procedures using factory
const { getByID, create, update } = createEntityCrudWithoutListProcedures({
  schemas: {
    createInput: locationCreateInput,
    updateInput: locationUpdateInput.shape.data,
    output: infLocation,
  },
  repository: {
    getByID: async (services, id) => {
      return await getLocationById(services.db, id, services.projectId);
    },
    create: async (services, data) => {
      if (!services.projectId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Project ID required",
        });
      }
      return await createLocation(services.db, data, services.projectId);
    },
    update: async (services, id, data) => {
      return await updateLocation(services.db, id, services.projectId, data);
    },
  },
});

const getLocationTypesCount = protectedProcedure
  .output(z.record(locationType, z.number()))
  .query(async ({ ctx }) => {
    return await buildLocationTypeCount(ctx.db, ctx.projectId);
  });

const makeTree = protectedProcedure
  .output(z.array(infLocation))
  .query(async ({ ctx }) => await buildLocationTree(ctx.db, ctx.projectId));

export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getLocationTypesCount,
  makeTree,
  create,
  update,
});
