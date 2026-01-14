import { z } from "zod";
import { categorySuggestionSchema } from "~/schemas/ai";
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
  isAvailable,
});
