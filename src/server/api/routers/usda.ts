import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { foodLookupParam, foodSummary } from "~/schemas/usda";
import { z } from "zod";
import { findFood, getFoodSummaryByID, listFoods } from "~/server/repo/usda";
import {
  createPaginatedResponseSchema,
  sortPaginationCombo,
  buildPaginatedResponse,
} from "~/schemas/util";

const getByAlternateID = publicProcedure
  .input(foodLookupParam)
  .output(foodSummary.nullable())
  .query(async ({ ctx, input }) => await findFood(ctx.db, input));

const getByID = publicProcedure
  .input(
    z.object({
      id: z.number(),
    }),
  )
  .output(foodSummary.nullable())
  .query(async ({ ctx, input }) => await getFoodSummaryByID(ctx.db, input.id));

const list = protectedProcedure
  .input(
    z
      .object({
        filters: z.object({
          nameFilter: z.string().optional(),
          dataTypeFilter: z.string().optional(),
        }),
      })
      .merge(sortPaginationCombo),
  )
  .output(createPaginatedResponseSchema(foodSummary))
  .query(async ({ ctx, input }) => {
    const { data, count } = await listFoods(
      ctx.db,
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
