import {
  categorySuggestionSchema,
  detectedInventorySchema,
  locationDescriptionSchema,
  locationTypeSuggestionSchema,
} from "@cubby/schemas/ai";
import { locationId } from "@cubby/schemas/identifiers";
import { z } from "zod";
import { getAnthropicClient } from "~/server/clients/anthropic";
import { getInventoryByLocationIds } from "~/server/repo/inventory";
import {
  findLocationsNeedingAiDescription,
  getLocationById,
  updateLocationAiDescription,
} from "~/server/repo/location";
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

/**
 * Analyze location photos and generate a description of contents.
 * Persists the description to the location record.
 */
const describeLocation = protectedProcedure
  .input(z.object({ locationId }))
  .output(locationDescriptionSchema)
  .mutation(async ({ ctx, input }) => {
    const location = await getLocationById(ctx.db, input.locationId);

    const imageUrls = location.images?.map((img) => img.url) ?? [];
    if (imageUrls.length === 0) {
      throw new Error("Location has no images to analyze");
    }

    const client = getAnthropicClient();
    const result = await client.describeLocation(
      imageUrls.slice(0, 5),
      location.name,
    );

    await updateLocationAiDescription(
      ctx.db,
      input.locationId,
      result.description,
    );

    return result;
  });

/**
 * Detect inventory items from location photos.
 * Returns detected items for user review — does not persist anything.
 */
const detectInventoryItems = protectedProcedure
  .input(z.object({ locationId }))
  .output(detectedInventorySchema)
  .mutation(async ({ ctx, input }) => {
    const location = await getLocationById(ctx.db, input.locationId);

    const imageUrls = location.images?.map((img) => img.url) ?? [];
    if (imageUrls.length === 0) {
      throw new Error("Location has no images to analyze");
    }

    // Get existing inventory item names to avoid duplicates
    const existingInventory = await getInventoryByLocationIds(ctx.db, [
      input.locationId,
    ]);
    const existingItemNames = existingInventory.map(
      (entry) => entry.product.name,
    );

    const client = getAnthropicClient();
    return client.detectInventoryItems(
      imageUrls.slice(0, 5),
      location.name,
      existingItemNames,
    );
  });

/**
 * Backfill AI descriptions for all locations that have images but no description.
 * Processes in batches of 10 for throughput while limiting concurrency.
 */
const backfillLocationDescriptions = protectedProcedure
  .output(z.object({ analyzed: z.number(), total: z.number() }))
  .mutation(async ({ ctx }) => {
    const client = getAnthropicClient();
    const locations = await findLocationsNeedingAiDescription(ctx.db);

    let analyzed = 0;
    for (let i = 0; i < locations.length; i += 10) {
      const batch = locations.slice(i, i + 10);
      const results = await Promise.allSettled(
        batch.map(async (loc) => {
          const result = await client.describeLocation(
            loc.imageUrls.slice(0, 5),
            loc.name,
          );
          await updateLocationAiDescription(ctx.db, loc.id, result.description);
        }),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          analyzed++;
        } else {
          console.error("Failed to describe location:", result.reason);
        }
      }
    }

    return { analyzed, total: locations.length };
  });

export const aiRouter = createTRPCRouter({
  suggestCategory,
  suggestLocationType,
  isAvailable,
  describeLocation,
  detectInventoryItems,
  backfillLocationDescriptions,
});
