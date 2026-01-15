import {
  type FoodLookupParam,
  type FoodSummary,
  foodLookupParam,
} from "@recipehub/usda-schemas";
import type { USDAClient } from "../clients/usda";

/**
 * Generic helper to enrich an array of items with USDA food data.
 *
 * This helper:
 * 1. Extracts lookup parameters from each item
 * 2. Batch fetches food data for valid lookups
 * 3. Maps food results back to original items
 */
export async function batchEnrichWithFood<T extends object>(
  items: T[],
  getLookupParam: (item: T) => FoodLookupParam | null,
  usdaClient: USDAClient,
): Promise<Array<T & { food: FoodSummary | null }>> {
  if (items.length === 0) {
    return [];
  }

  // Phase 1: Try primary lookups (UPC prioritized by getLookupParam)
  const lookupParams = items.map((item) => getLookupParam(item));
  const validLookups = lookupParams.filter(
    (param): param is NonNullable<typeof param> => param !== null,
  );

  const primaryResults =
    validLookups.length > 0
      ? await usdaClient.findFoodsBatch(validLookups)
      : [];

  // Map primary results back to items
  const resultsMap = new Map<number, FoodSummary | null>();
  let resultIndex = 0;
  items.forEach((item, itemIndex) => {
    const lookupParam = getLookupParam(item);
    if (lookupParam) {
      resultsMap.set(itemIndex, primaryResults[resultIndex++] || null);
    } else {
      resultsMap.set(itemIndex, null);
    }
  });

  // Phase 2: Identify failures that have NDB fallback available
  type ItemWithIndex = { item: T; itemIndex: number };
  const failedItems: ItemWithIndex[] = [];
  const fallbackLookups: FoodLookupParam[] = [];

  items.forEach((item, itemIndex) => {
    const result = resultsMap.get(itemIndex);
    const primaryLookup = getLookupParam(item);

    // Check if: (1) primary failed, (2) primary was UPC, (3) item has NDB
    if (
      result === null &&
      primaryLookup?.kind === "upc" &&
      "ndb_number" in item &&
      item.ndb_number !== null
    ) {
      const ndbParam = foodLookupParam.safeParse({
        kind: "ndb",
        ndb_number: item.ndb_number,
      });
      if (ndbParam.success) {
        failedItems.push({ item, itemIndex });
        fallbackLookups.push(ndbParam.data);
      }
    }
  });

  // Batch retry with NDB if any failures have fallback available
  if (fallbackLookups.length > 0) {
    const fallbackResults = await usdaClient.findFoodsBatch(fallbackLookups);

    // Update results map with successful fallbacks
    fallbackResults.forEach((food, i) => {
      if (food) {
        const { itemIndex } = failedItems[i]!;
        resultsMap.set(itemIndex, food);
      }
    });
  }

  // Return items with food data
  return items.map((item, itemIndex) => ({
    ...item,
    food: resultsMap.get(itemIndex) || null,
  }));
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
