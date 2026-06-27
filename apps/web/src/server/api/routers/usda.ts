import {
  buildPaginatedResponse,
  createPaginatedResponseSchema,
  sortPaginationCombo,
} from "@cubby/schemas/pagination";
import {
  foodSummaryEnrichment,
  foodSummaryWithLinkedProducts,
} from "@cubby/schemas/usda";
import {
  dataTypeEnum,
  foodLookupParam,
  foodSummary,
} from "@cubby/usda-schemas";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const usdaListInput = z
  .object({
    filters: z.object({
      nameFilter: z.string().optional(),
      dataTypeFilter: dataTypeEnum.optional(),
      dataTypes: z.array(dataTypeEnum).optional(),
      foodsOnly: z.boolean().optional(),
    }),
  })
  .extend(sortPaginationCombo.shape);

// These return `foodSummaryWithLinkedProducts`, which embeds internal Cubby
// product data (ids, prices, externalIds). The app is deployed publicly, so
// these must require an authenticated session — do not downgrade to
// publicProcedure without splitting off the linkedProducts enrichment.
const getByAlternateID = protectedProcedure
  .input(foodLookupParam)
  .output(foodSummaryWithLinkedProducts.nullable())
  .query(async ({ ctx, input }) => {
    return await ctx.usdaService.findFood(input);
  });

const getByID = protectedProcedure
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
  .input(usdaListInput)
  .output(createPaginatedResponseSchema(foodSummaryWithLinkedProducts))
  .query(async ({ ctx, input }) => {
    try {
      const { data, count } = await ctx.usdaService.listFoods(
        input.filters.nameFilter,
        input.filters.dataTypeFilter,
        input.sort,
        input.pagination,
        input.filters.foodsOnly,
        input.filters.dataTypes,
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

const listSummaries = protectedProcedure
  .input(usdaListInput)
  .output(createPaginatedResponseSchema(foodSummary))
  .query(async ({ ctx, input }) => {
    try {
      const { data, count } = await ctx.usdaService.listFoodSummaries(
        input.filters.nameFilter,
        input.filters.dataTypeFilter,
        input.sort,
        input.pagination,
        input.filters.foodsOnly,
        input.filters.dataTypes,
      );

      return buildPaginatedResponse(input.pagination, data, count);
    } catch (e) {
      console.error(
        "[usda.listSummaries] failed, returning empty:",
        e,
        e instanceof Error ? e.cause : undefined,
      );
      return buildPaginatedResponse(input.pagination, [], 0);
    }
  });

const enrichmentsByID = protectedProcedure
  .input(z.object({ fdcIds: z.array(z.number()).max(1000) }))
  .output(z.record(z.string(), foodSummaryEnrichment))
  .query(async ({ ctx, input }) => {
    return await ctx.usdaService.getFoodEnrichmentsByID(input.fdcIds);
  });

export const usdaRouter = createTRPCRouter({
  getByAlternateID,
  getByID,
  list,
  listSummaries,
  enrichmentsByID,
});
