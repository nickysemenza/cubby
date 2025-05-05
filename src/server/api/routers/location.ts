import { z } from "zod";
import { publicProcedure, createTRPCRouter } from "../trpc";
import {
  createPaginatedResponseSchema,
  IDInput,
  sortPaginationCombo,
  buildPaginatedResponse,
} from "~/schemas/util";
import { infLocation, locationType } from "~/schemas/location";
import {
  buildLocationTree,
  buildLocationTypeCount,
  getLocationById,
  locationList,
  createLocation,
  updateLocation,
} from "~/server/repo/location";
import { locationOutWithParentChildrenAndInventoryOut } from "~/schemas/combo";

const list = publicProcedure
  .input(
    z
      .object({
        filters: z.object({
          nameFilter: z.string().optional(),
          itemTypeFilter: locationType.optional(),
        }),
      })
      .merge(sortPaginationCombo),
  )
  .output(
    createPaginatedResponseSchema(locationOutWithParentChildrenAndInventoryOut),
  )
  .query(async ({ ctx, input }) => {
    const { data, count } = await locationList(
      ctx.db,
      input.filters.nameFilter,
      input.filters.itemTypeFilter,
      input.sort,
      input.pagination,
    );

    return buildPaginatedResponse(input.pagination, data, count);
  });

const getByID = publicProcedure
  .meta({ description: "location with infiinte parent and 1 child" })
  .input(IDInput)
  .output(infLocation)
  .query(async ({ ctx, input }) => await getLocationById(ctx.db, input.id));

const getLocationTypesCount = publicProcedure
  .output(z.record(locationType, z.number()))
  .query(async ({ ctx }) => {
    return await buildLocationTypeCount(ctx.db);
  });

const makeTree = publicProcedure
  .output(z.array(infLocation))
  .query(async ({ ctx }) => await buildLocationTree(ctx.db));

// Create location schemas
const locationCreatePayloadData = z.object({
  name: z.string().min(1),
  type: locationType,
  parentId: z.string().uuid().nullable(),
});

// Create location endpoint
const create = publicProcedure
  .input(locationCreatePayloadData)
  .output(infLocation)
  .mutation(async ({ ctx, input }) => {
    return await createLocation(ctx.db, input);
  });

// Update location schema
const locationUpdatePayloadData = z.object({
  id: z.string().uuid(),
  data: z.object({
    name: z.string().min(1).optional(),
    type: locationType.optional(),
    parentId: z.string().uuid().nullable().optional(),
  }),
});

// Update location endpoint
const update = publicProcedure
  .input(locationUpdatePayloadData)
  .output(infLocation)
  .mutation(async ({ ctx, input }) => {
    return await updateLocation(ctx.db, input.id, input.data);
  });

export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getLocationTypesCount,
  makeTree,
  create,
  update,
});
