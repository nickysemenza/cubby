import {
  type FoodLookupParam,
  type FoodSummary,
} from "@recipehub/usda-schemas";
import { type USDAClient } from "../clients/usda";

/**
 * Generic helper to enrich an array of items with USDA food data.
 *
 * This helper:
 * 1. Extracts lookup parameters from each item
 * 2. Batch fetches food data for valid lookups
 * 3. Maps food results back to original items
 *
 * @param items - Array of items to enrich with food data
 * @param getLookupParam - Function to extract FoodLookupParam from an item
 * @param usdaClient - USDA client instance for fetching food data
 * @returns Array of items enriched with food property (null if no lookup param or not found)
 *
 * @example
 * const productsWithFood = await batchEnrichWithFood(
 *   products,
 *   foodLookupParamFromProduct,
 *   usdaClient
 * );
 */
export async function batchEnrichWithFood<T>(
  items: T[],
  getLookupParam: (item: T) => FoodLookupParam | null,
  usdaClient: USDAClient,
): Promise<Array<T & { food: FoodSummary | null }>> {
  if (items.length === 0) {
    return [];
  }

  // Collect all lookup parameters
  const lookupParams = items.map((item) => getLookupParam(item));
  const validLookups = lookupParams.filter(
    (param): param is NonNullable<typeof param> => param !== null,
  );

  // Batch fetch food data
  const foodResults =
    validLookups.length > 0
      ? await usdaClient.findFoodsBatch(validLookups)
      : [];

  // Map foods back to items
  let foodIndex = 0;
  return items.map((item) => {
    const lookupParam = getLookupParam(item);
    const food = lookupParam ? foodResults[foodIndex++] : null;
    return {
      ...item,
      food,
    };
  });
}
