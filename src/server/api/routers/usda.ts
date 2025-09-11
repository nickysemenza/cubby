import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { foodLookupParam, foodSummary } from "~/schemas/usda";
import { z } from "zod";
import { USDAClient } from "~/server/repo/usda";
import {
  createPaginatedResponseSchema,
  sortPaginationCombo,
  buildPaginatedResponse,
} from "~/schemas/pagination";

const getByAlternateID = publicProcedure
  .input(foodLookupParam)
  .output(foodSummary.nullable())
  .query(async ({ ctx, input }) => {
    const client = new USDAClient(ctx.db);
    return await client.findFood(input);
  });

const getByID = publicProcedure
  .input(
    z.object({
      id: z.number(),
    }),
  )
  .output(foodSummary.nullable())
  .query(async ({ ctx, input }) => {
    const client = new USDAClient(ctx.db);
    return await client.getFoodSummaryByID(input.id);
  });

const list = protectedProcedure
  .input(
    z
      .object({
        filters: z.object({
          nameFilter: z.string().optional(),
          dataTypeFilter: z.string().optional(),
        }),
      })
      .extend(sortPaginationCombo.shape),
  )
  .output(createPaginatedResponseSchema(foodSummary))
  .query(async ({ ctx, input }) => {
    const client = new USDAClient(ctx.db);
    const { data, count } = await client.listFoods(
      input.filters.nameFilter,
      input.filters.dataTypeFilter,
      input.sort,
      input.pagination,
    );

    return buildPaginatedResponse(input.pagination, data, count);
  });

export const usdaRouter = createTRPCRouter({
  getByAlternateID,
  getByID,
  list,
});
