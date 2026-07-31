import {
  aiLocationIdInput,
  aiUsageRecentInput,
  aiUsageRecentOut,
  aiUsageSummaryInput,
  aiUsageSummaryOut,
  approveDetectedInventoryItemInput,
  approveDetectedInventoryItemOut,
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
import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import { streamProgress } from "~/lib/bulk-progress";
import {
  CATEGORY_DESCRIPTIONS,
  getAnthropicClient,
} from "~/server/clients/anthropic";
import { createAppError } from "~/server/errors/app-error";
import { listRecentAiUsage, summarizeAiUsage } from "~/server/repo/ai-usage";
import { getLocationNames } from "~/server/repo/location/crud";
import { getProductSummaryForAudit } from "~/server/repo/product";
import { resolveLiveShortcodes } from "~/server/repo/shortcode-resolver";
import { suggestIngredientMergeBatch } from "~/server/services/ai-enrichment/ingredient-merge";
import {
  approveDetectedInventoryItem,
  backfillLocationDescriptions,
  describeLocation,
  detectInventoryItems,
} from "~/server/services/ai-enrichment/location-vision";
import { precomputeEnrichmentProposals } from "~/server/services/ai-enrichment/proposals";
import {
  suggestUsdaFood,
  suggestUsdaFoodBatch,
} from "~/server/services/ai-enrichment/usda-match";
import { createTRPCRouter, protectedProcedure } from "../trpc";

/**
 * Suggest a category for a product based on its name and manufacturer
 */
const suggestCategory = protectedProcedure
  .input(categorySuggestionInput)
  .output(categorySuggestionSchema)
  .query(async ({ ctx, input }) => {
    const client = getAnthropicClient();
    return client.suggestCategory(input.productName, input.manufacturer, {
      db: ctx.db,
      feature: "product-category-suggestion",
      operation: "suggestCategory",
      cacheStatus: "none",
    });
  });

/**
 * Suggest a location type based on the location name
 */
const suggestLocationType = protectedProcedure
  .input(locationTypeSuggestionInput)
  .output(locationTypeSuggestionSchema)
  .query(async ({ ctx, input }) => {
    const client = getAnthropicClient();
    return client.suggestLocationType(input.locationName, {
      db: ctx.db,
      feature: "location-type-suggestion",
      operation: "suggestLocationType",
      cacheStatus: "none",
    });
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
  approveDetectedInventoryItem: protectedProcedure
    .input(approveDetectedInventoryItemInput)
    .output(approveDetectedInventoryItemOut)
    .mutation(async ({ ctx, input }) => {
      return await approveDetectedInventoryItem(
        ctx.db,
        input,
        ctx.actorContext,
      );
    }),
  backfillLocationDescriptions: protectedProcedure.mutation(async function* ({
    ctx,
  }) {
    yield* streamProgress(backfillLocationDescriptions(ctx.db), (r) => r);
  }),
  identifyProduct: protectedProcedure
    .input(productIdentificationInput)
    .output(productIdentificationSchema)
    .mutation(async ({ ctx, input }) => {
      const client = getAnthropicClient();
      return client.identifyProduct(input.imageUrls, {
        db: ctx.db,
        feature: "product-identification",
        operation: "identifyProduct",
        cacheStatus: "none",
      });
    }),
  // Agentic USDA matcher: the model searches USDA itself, then picks the best
  // food for a stub ingredient. Returns the full chosen food (or null).
  suggestUsdaFood: protectedProcedure
    .input(usdaFoodSuggestionInput)
    .output(usdaFoodSuggestionOut)
    .mutation(async ({ ctx, input }) => {
      return suggestUsdaFood(ctx.usdaService, ctx.db, input.ingredientName);
    }),
  // Batch USDA matcher for the workbench's "Suggest USDA for selected" action.
  // Read-only: returns one suggestion per name for review; links nothing.
  suggestUsdaFoodBatch: protectedProcedure
    .input(usdaFoodSuggestionBatchInput)
    .output(usdaFoodSuggestionBatchOut)
    .mutation(async ({ ctx, input }) => {
      return suggestUsdaFoodBatch(
        ctx.usdaService,
        ctx.db,
        input.ingredientNames,
      );
    }),
  // Batch AI merge suggester for the workbench's "Suggest merges" action. Tool-
  // calling agent searches existing ingredients; read-only, the user confirms.
  suggestIngredientMergeBatch: protectedProcedure
    .input(ingredientMergeSuggestionBatchInput)
    .output(ingredientMergeSuggestionBatchOut)
    .mutation(async ({ ctx, input }) => {
      const resolved = await resolveLiveShortcodes(
        ctx.db,
        input.ingredients.map((ingredient) => ingredient.id),
        "ingredient",
      );
      const result = await suggestIngredientMergeBatch(
        ctx.db,
        input.ingredients.map((ingredient) => {
          const entityId = resolved.get(ingredient.id);
          if (!entityId) {
            throw createAppError(
              "INGREDIENT_NOT_FOUND",
              `Ingredient ${ingredient.id} not found`,
            );
          }
          return {
            id: unsafeIngredientId(entityId),
            shortcode: ingredient.id,
            name: ingredient.name,
          };
        }),
      );
      return result.map(({ source, target, ...suggestion }) => ({
        ...suggestion,
        source: { id: source.shortcode, name: source.name },
        target: target ? { id: target.shortcode, name: target.name } : null,
      }));
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
      return client.parseSearchQuery(input.query, locationNames, {
        db: ctx.db,
        feature: "search-query-parse",
        operation: "parseSearchQuery",
        cacheStatus: "none",
      });
    }),
  auditCategories: protectedProcedure
    .output(categoryAuditSchema)
    .mutation(async ({ ctx }) => {
      const client = getAnthropicClient();
      const products = await getProductSummaryForAudit(ctx.db);
      return client.auditCategories(products, CATEGORY_DESCRIPTIONS, {
        db: ctx.db,
        feature: "category-audit",
        operation: "auditCategories",
        cacheStatus: "none",
      });
    }),
  usageRecent: protectedProcedure
    .input(aiUsageRecentInput)
    .output(aiUsageRecentOut)
    .query(async ({ ctx, input }) => {
      return await listRecentAiUsage(ctx.db, input.limit);
    }),
  usageSummary: protectedProcedure
    .input(aiUsageSummaryInput)
    .output(aiUsageSummaryOut)
    .query(async ({ ctx, input }) => {
      return await summarizeAiUsage(ctx.db, input.days);
    }),
});
