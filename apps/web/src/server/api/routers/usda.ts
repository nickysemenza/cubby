import { dataTypeEnum, foodLookupParam } from "@cubby/usda-schemas";
import { z } from "zod";
import { foodSummaryWithLinkedProducts } from "~/schemas/combo";
import {
  buildPaginatedResponse,
  createPaginatedResponseSchema,
  sortPaginationCombo,
} from "~/schemas/pagination";
import { createTRPCRouter, publicProcedure } from "../trpc";

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

const list = publicProcedure
  .input(
    z
      .object({
        filters: z.object({
          nameFilter: z.string().optional(),
          dataTypeFilter: dataTypeEnum.optional(),
        }),
      })
      .extend(sortPaginationCombo.shape),
  )
  .output(createPaginatedResponseSchema(foodSummaryWithLinkedProducts))
  .query(async ({ ctx, input }) => {
    try {
      const { data, count } = await ctx.usdaService.listFoods(
        input.filters.nameFilter,
        input.filters.dataTypeFilter,
        input.sort,
        input.pagination,
      );

      return buildPaginatedResponse(input.pagination, data, count);
    } catch (e) {
      // Degrade gracefully — don't let a slow/down USDA API kill the entire batch
      console.error(
        "[usda.list] failed, returning empty:",
        e,
        e instanceof Error ? e.cause : undefined,
      );
      return buildPaginatedResponse(input.pagination, [], 0);
    }
  });

export const usdaRouter = createTRPCRouter({
  getByAlternateID,
  getByID,
  list,
});
