import {
  categoryAuditSchema,
  categorySuggestionSchema,
  confidence,
  detectedInventorySchema,
  locationDescriptionSchema,
  locationTypeSuggestionSchema,
  parsedSearchSchema,
  productIdentificationSchema,
} from "@cubby/schemas/ai";
import { foodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import { locationId } from "@cubby/schemas/identifiers";
import { z } from "zod";
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
  suggestUsdaFood,
} from "~/server/services/ai-enrichment.service";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

/**
 * Suggest a category for a product based on its name and manufacturer
 */
const suggestCategory = protectedProcedure
  .input(
    z.object({
      productName: z.string().min(1),
      manufacturer: z.string().min(1),
    }),
  )
  .output(categorySuggestionSchema)
  .query(async ({ input }) => {
    const client = getAnthropicClient();
    return client.suggestCategory(input.productName, input.manufacturer);
  });

/**
 * Suggest a location type based on the location name
 */
const suggestLocationType = protectedProcedure
  .input(z.object({ locationName: z.string().min(1) }))
  .output(locationTypeSuggestionSchema)
  .query(async ({ input }) => {
    const client = getAnthropicClient();
    return client.suggestLocationType(input.locationName);
  });

/**
 * Check if AI features are available (API key configured)
 */
const isAvailable = publicProcedure
  .output(z.object({ available: z.boolean() }))
  .query(() => {
    const client = getAnthropicClient();
    return { available: client.isConfigured() };
  });

export const aiRouter = createTRPCRouter({
  suggestCategory,
  suggestLocationType,
  isAvailable,
  describeLocation: protectedProcedure
    .input(z.object({ locationId }))
    .output(locationDescriptionSchema)
    .mutation(async ({ ctx, input }) => {
      return describeLocation(ctx.db, input.locationId);
    }),
  detectInventoryItems: protectedProcedure
    .input(z.object({ locationId }))
    .output(detectedInventorySchema)
    .mutation(async ({ ctx, input }) => {
      return detectInventoryItems(ctx.db, input.locationId);
    }),
  backfillLocationDescriptions: protectedProcedure
    .output(z.object({ analyzed: z.number(), total: z.number() }))
    .mutation(async ({ ctx }) => {
      return backfillLocationDescriptions(ctx.db);
    }),
  identifyProduct: protectedProcedure
    .input(
      z.object({
        imageUrls: z.array(z.string().url()).min(1).max(5),
      }),
    )
    .output(productIdentificationSchema)
    .mutation(async ({ input }) => {
      const client = getAnthropicClient();
      return client.identifyProduct(input.imageUrls);
    }),
  // Agentic USDA matcher: the model searches USDA itself, then picks the best
  // food for a stub ingredient. Returns the full chosen food (or null).
  suggestUsdaFood: protectedProcedure
    .input(z.object({ ingredientName: z.string().min(1) }))
    .output(
      z.object({
        food: foodSummaryWithLinkedProducts.nullable(),
        confidence,
        reasoning: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return suggestUsdaFood(ctx.usdaService, input.ingredientName);
    }),
  parseSearch: protectedProcedure
    .input(z.object({ query: z.string().min(1) }))
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
