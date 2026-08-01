import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import {
  foodSummaryWithLinkedProducts,
  usdaFoodEnrichmentsInput,
  usdaFoodEnrichmentsOut,
  usdaFoodIdInput,
  usdaFoodListOut,
  usdaFoodLookupInput,
  usdaFoodSummaryListOut,
  usdaListInput,
} from "@cubby/schemas/usda";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

// These return `foodSummaryWithLinkedProducts`, which embeds internal Cubby
// product data (ids, prices, externalIds). The app is deployed publicly, so
// these must require an authenticated session — do not downgrade to
// publicProcedure without splitting off the linkedProducts enrichment.
const getByAlternateID = protectedProcedure
  .input(usdaFoodLookupInput)
  .output(strictOutput(foodSummaryWithLinkedProducts.nullable()))
  .query(async ({ ctx, input }) => {
    return await ctx.usdaService.findFood(input);
  });

const getByID = protectedProcedure
  .input(usdaFoodIdInput)
  .output(strictOutput(foodSummaryWithLinkedProducts.nullable()))
  .query(async ({ ctx, input }) => {
    return await ctx.usdaService.getFoodSummaryByID(input.id);
  });

const list = protectedProcedure
  .input(usdaListInput)
  .output(strictOutput(usdaFoodListOut))
  .query(async ({ ctx, input }) => {
    try {
      const { data, count } = await ctx.usdaService.listFoods(
        input.filters.nameFilter,
        input.filters.dataTypeFilter,
        // The remote usda-api contract is single-sort; take the primary.
        normalizeSorts(input.sort)[0]!,
        input.pagination,
        input.filters.foodsOnly,
        input.filters.dataTypes,
        input.filters.linkedProductsOnly,
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
  .output(strictOutput(usdaFoodSummaryListOut))
  .query(async ({ ctx, input }) => {
    try {
      const { data, count } = await ctx.usdaService.listFoodSummaries(
        input.filters.nameFilter,
        input.filters.dataTypeFilter,
        // The remote usda-api contract is single-sort; take the primary.
        normalizeSorts(input.sort)[0]!,
        input.pagination,
        input.filters.foodsOnly,
        input.filters.dataTypes,
        input.filters.linkedProductsOnly,
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
  .input(usdaFoodEnrichmentsInput)
  .output(strictOutput(usdaFoodEnrichmentsOut))
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
