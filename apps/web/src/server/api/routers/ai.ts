import {
  aiLocationIdInput,
  categoryAuditSchema,
  categorySuggestionInput,
  categorySuggestionSchema,
  detectedInventorySchema,
  enrichmentProposalPrecomputeInput,
  ingredientMergeSuggestionBatchInput,
  ingredientMergeSuggestionBatchOut,
  locationDescriptionSchema,
  locationTypeSuggestionInput,
  locationTypeSuggestionSchema,
  parsedSearchSchema,
  parseSearchInput,
  productIdentificationInput,
  productIdentificationSchema,
  usdaFoodSuggestionBatchInput,
  usdaFoodSuggestionBatchOut,
  usdaFoodSuggestionInput,
  usdaFoodSuggestionOut,
} from "@cubby/schemas/ai";
import { streamProgress } from "~/lib/bulk-progress";
import {
  CATEGORY_DESCRIPTIONS,
  getAnthropicClient,
} from "~/server/clients/anthropic";
import { getLocationNames } from "~/server/repo/location/crud";
import { getProductSummaryForAudit } from "~/server/repo/product";
import {
  backfillLocationDescriptions,
  describeLocation,
  detectInventoryItems,
  precomputeEnrichmentProposals,
  suggestIngredientMergeBatch,
  suggestUsdaFood,
  suggestUsdaFoodBatch,
} from "~/server/services/ai-enrichment.service";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * Suggest a category for a product based on its name and manufacturer
 */
const suggestCategory = protectedProcedure
  .input(categorySuggestionInput)
  .output(categorySuggestionSchema)
  .query(async ({ input }) => {
    const client = getAnthropicClient();
    return client.suggestCategory(input.productName, input.manufacturer);
  });

/**
 * Suggest a location type based on the location name
 */
const suggestLocationType = protectedProcedure
  .input(locationTypeSuggestionInput)
  .output(locationTypeSuggestionSchema)
  .query(async ({ input }) => {
    const client = getAnthropicClient();
    return client.suggestLocationType(input.locationName);
  });

export const aiRouter = createTRPCRouter({
  suggestCategory,
  suggestLocationType,
  describeLocation: protectedProcedure
    .input(aiLocationIdInput)
    .output(locationDescriptionSchema)
    .mutation(async ({ ctx, input }) => {
      return describeLocation(ctx.db, input.locationId);
    }),
  detectInventoryItems: protectedProcedure
    .input(aiLocationIdInput)
    .output(detectedInventorySchema)
    .mutation(async ({ ctx, input }) => {
      return detectInventoryItems(ctx.db, input.locationId);
    }),
  backfillLocationDescriptions: protectedProcedure.mutation(async function* ({
    ctx,
  }) {
    yield* streamProgress(backfillLocationDescriptions(ctx.db), (r) => r);
  }),
  identifyProduct: protectedProcedure
    .input(productIdentificationInput)
    .output(productIdentificationSchema)
    .mutation(async ({ input }) => {
      const client = getAnthropicClient();
      return client.identifyProduct(input.imageUrls);
    }),
  // Agentic USDA matcher: the model searches USDA itself, then picks the best
  // food for a stub ingredient. Returns the full chosen food (or null).
  suggestUsdaFood: protectedProcedure
    .input(usdaFoodSuggestionInput)
    .output(usdaFoodSuggestionOut)
    .mutation(async ({ ctx, input }) => {
      return suggestUsdaFood(ctx.usdaService, input.ingredientName);
    }),
  // Batch USDA matcher for the workbench's "Suggest USDA for selected" action.
  // Read-only: returns one suggestion per name for review; links nothing.
  suggestUsdaFoodBatch: protectedProcedure
    .input(usdaFoodSuggestionBatchInput)
    .output(usdaFoodSuggestionBatchOut)
    .mutation(async ({ ctx, input }) => {
      return suggestUsdaFoodBatch(ctx.usdaService, input.ingredientNames);
    }),
  // Batch AI merge suggester for the workbench's "Suggest merges" action. Tool-
  // calling agent searches existing ingredients; read-only, the user confirms.
  suggestIngredientMergeBatch: protectedProcedure
    .input(ingredientMergeSuggestionBatchInput)
    .output(ingredientMergeSuggestionBatchOut)
    .mutation(async ({ ctx, input }) => {
      return suggestIngredientMergeBatch(ctx.db, input.ingredients);
    }),
  // Streamed, read-only pre-compute for the enrichment review queue: one event
  // per ingredient carrying its USDA (and optional merge) proposal, so the
  // client can fill a cache ahead of the user. Links/merges nothing. The client
  // pages the worklist (~25/page); cap a page so one request stays bounded.
  precomputeEnrichmentProposals: protectedProcedure
    .input(enrichmentProposalPrecomputeInput)
    .mutation(async function* ({ ctx, input }) {
      yield* precomputeEnrichmentProposals(
        ctx.usdaService,
        ctx.db,
        input.items,
      );
    }),
  parseSearch: protectedProcedure
    .input(parseSearchInput)
    .output(parsedSearchSchema)
    .mutation(async ({ ctx, input }) => {
      const client = getAnthropicClient();
      const locationNames = await getLocationNames(ctx.db);
      return client.parseSearchQuery(input.query, locationNames);
    }),
  auditCategories: protectedProcedure
    .output(categoryAuditSchema)
    .mutation(async ({ ctx }) => {
      const client = getAnthropicClient();
      const products = await getProductSummaryForAudit(ctx.db);
      return client.auditCategories(products, CATEGORY_DESCRIPTIONS);
    }),
});
