import { z } from "zod";
import {
  protectedProcedure,
  createTRPCRouter,
  requireActorContext,
} from "../trpc";
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
      // organizationId guaranteed non-null by requireOrganization middleware
      return await locationList(
        services.db,
        services.organizationId!,
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
    idSchema: locationId,
  },
  repository: {
    getByID: async (services, id: LocationId) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await getLocationById(services.db, id, services.organizationId!);
    },
    create: async (services, data) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      const actor = requireActorContext(services);
      return await createLocation(services.db, data, actor);
    },
    update: async (services, id: LocationId, data) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      const actor = requireActorContext(services);
      return await updateLocation(services.db, id, data, actor);
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

export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getLocationTypesCount,
  makeTree,
  create,
  update,
});
