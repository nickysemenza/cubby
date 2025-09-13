import { z } from "zod";
import { publicProcedure, createTRPCRouter } from "../trpc";
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
      return await getLocationById(services.db, id);
    },
    create: async (services, data) => {
      return await createLocation(services.db, data);
    },
    update: async (services, id, data) => {
      return await updateLocation(services.db, id, data);
    },
  },
});

const getLocationTypesCount = publicProcedure
  .output(z.record(locationType, z.number()))
  .query(async ({ ctx }) => {
    return await buildLocationTypeCount(ctx.db);
  });

const makeTree = publicProcedure
  .output(z.array(infLocation))
  .query(async ({ ctx }) => await buildLocationTree(ctx.db));

export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getLocationTypesCount,
  makeTree,
  create,
  update,
});
