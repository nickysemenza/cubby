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

/**
 * Batch enriches nested items across a collection of parent items.
 *
 * This helper consolidates the pattern of:
 * 1. Flattening nested items from all parents
 * 2. Batch enriching all nested items at once
 * 3. Mapping enriched items back to their respective parents
 *
 * Useful for enriching nested collections (e.g., products within ingredients)
 * while maintaining batch efficiency and proper parent-child relationships.
 *
 * @param parents - Array of parent items containing nested items
 * @param getNestedItems - Function to extract nested items array from a parent
 * @param enrichFn - Async function to batch enrich all nested items
 * @param mapBack - Function to create new parent with enriched nested items
 * @returns Array of parents with their nested items enriched
 *
 * @example
 * ```typescript
 * // Enrich products within ingredients
 * const enrichedIngredients = await batchEnrichNestedItems(
 *   ingredients,
 *   (ing) => ing.product,
 *   (products) => enrichProductsWithFood(products),
 *   (ing, enrichedProducts) => ({ ...ing, product: enrichedProducts })
 * );
 * ```
 */
export async function batchEnrichNestedItems<
  TParent,
  TNested,
  TEnriched,
  TResult = TParent,
>(
  parents: TParent[],
  getNestedItems: (parent: TParent) => TNested[],
  enrichFn: (items: TNested[]) => Promise<TEnriched[]>,
  mapBack: (parent: TParent, enriched: TEnriched[]) => TResult,
): Promise<TResult[]> {
  if (parents.length === 0) {
    return [];
  }

  // Flatten all nested items and track counts per parent
  const allNested: TNested[] = [];
  const countsPerParent: number[] = [];

  parents.forEach((parent) => {
    const nested = getNestedItems(parent);
    countsPerParent.push(nested.length);
    allNested.push(...nested);
  });

  // Batch enrich all nested items at once
  const allEnriched = await enrichFn(allNested);

  // Map enriched items back to their parents
  let currentIndex = 0;
  return parents.map((parent, parentIndex) => {
    const count = countsPerParent[parentIndex] || 0;
    const enrichedForParent = allEnriched.slice(
      currentIndex,
      currentIndex + count,
    );
    currentIndex += count;
    return mapBack(parent, enrichedForParent);
  });
}
