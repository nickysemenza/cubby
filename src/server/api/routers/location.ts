import { z } from "zod";
import { publicProcedure, createTRPCRouter } from "../trpc";
import {
  createPaginatedResponseSchema,
  IDInput,
  sortPaginationCombo,
  buildPaginatedResponse,
} from "~/schemas/util";
import {
  infLocation,
  locationOutWithParentChildren,
  locationType,
} from "~/schemas/location";
import {
  buildLocationTree,
  buildLocationTypeCount,
  getLocationById,
  locationList,
} from "~/server/repo/location";

const list = publicProcedure
  .input(
    z
      .object({
        nameFilter: z.string().optional(),
        itemTypeFilter: locationType.optional(),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(locationOutWithParentChildren))
  .query(async ({ ctx, input }) => {
    const { data, count } = await locationList(
      ctx.db,
      input.nameFilter,
      input.itemTypeFilter,
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

export const locationRouter = createTRPCRouter({
  list,
  getByID,
  getLocationTypesCount,
  makeTree,
});
