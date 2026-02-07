import {
  categorySuggestionSchema,
  locationTypeSuggestionSchema,
} from "@cubby/schemas/ai";
import { z } from "zod";
import { getAnthropicClient } from "~/server/clients/anthropic";
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
});
