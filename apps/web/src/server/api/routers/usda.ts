import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { foodLookupParam } from "~/schemas/usda";
import { foodSummaryWithLinkedProducts } from "~/schemas/combo";
import { z } from "zod";
import {
  createPaginatedResponseSchema,
  sortPaginationCombo,
  buildPaginatedResponse,
} from "~/schemas/pagination";

const getByAlternateID = publicProcedure
  .input(foodLookupParam)
  .output(foodSummaryWithLinkedProducts.nullable())
  .query(async ({ ctx, input }) => {
    return await ctx.usdaService.findFood(input);
  });

const getByID = publicProcedure
  .input(
    z.object({
      id: z.number(),
    }),
  )
  .output(foodSummaryWithLinkedProducts.nullable())
  .query(async ({ ctx, input }) => {
    return await ctx.usdaService.getFoodSummaryByID(input.id);
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
  .output(createPaginatedResponseSchema(foodSummaryWithLinkedProducts))
  .query(async ({ ctx, input }) => {
    const { data, count } = await ctx.usdaService.listFoods(
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
