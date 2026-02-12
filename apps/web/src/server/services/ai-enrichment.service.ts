/**
 * Service for AI-powered enrichment of locations and inventory.
 *
 * Handles multi-step orchestration: fetching images, calling Anthropic, persisting results.
 */

import type { LocationDescription } from "@cubby/schemas/ai";
import type { LocationId } from "@cubby/schemas/identifiers";
import { getAnthropicClient } from "~/server/clients/anthropic";
import type { Database } from "~/server/db";
import { getInventoryByLocationIds } from "~/server/repo/inventory";
import {
  findLocationsNeedingAiDescription,
  getLocationById,
  updateLocationAiDescription,
} from "~/server/repo/location";

/**
 * Analyze location photos and generate a description of contents.
 * Persists the description to the location record.
 */
export async function describeLocation(
  db: Database,
  locationId: LocationId,
): Promise<LocationDescription> {
  const location = await getLocationById(db, locationId);

  const imageUrls = location.images?.map((img) => img.url) ?? [];
  if (imageUrls.length === 0) {
    throw new Error("Location has no images to analyze");
  }

  const client = getAnthropicClient();
  const result = await client.describeLocation(
    imageUrls.slice(0, 5),
    location.name,
  );

  await updateLocationAiDescription(db, locationId, result.description);

  return result;
}

/**
 * Detect inventory items from location photos.
 * Returns detected items for user review — does not persist anything.
 */
export async function detectInventoryItems(
  db: Database,
  locationId: LocationId,
) {
  const location = await getLocationById(db, locationId);

  const imageUrls = location.images?.map((img) => img.url) ?? [];
  if (imageUrls.length === 0) {
    throw new Error("Location has no images to analyze");
  }

  // Get existing inventory item names to avoid duplicates
  const existingInventory = await getInventoryByLocationIds(db, [locationId]);
  const existingItemNames = existingInventory.map(
    (entry) => entry.product.name,
  );

  const client = getAnthropicClient();
  return client.detectInventoryItems(
    imageUrls.slice(0, 5),
    location.name,
    existingItemNames,
  );
}

/**
 * Backfill AI descriptions for all locations that have images but no description.
 * Processes in batches of 10 for throughput while limiting concurrency.
 */
export async function backfillLocationDescriptions(
  db: Database,
): Promise<{ analyzed: number; total: number }> {
  const client = getAnthropicClient();
  const locations = await findLocationsNeedingAiDescription(db);

  let analyzed = 0;
  for (let i = 0; i < locations.length; i += 10) {
    const batch = locations.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async (loc) => {
        const result = await client.describeLocation(
          loc.imageUrls.slice(0, 5),
          loc.name,
        );
        await updateLocationAiDescription(db, loc.id, result.description);
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
}
