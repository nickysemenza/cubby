import type { FoodLookupParam, FoodSummary } from "@cubby/usda-schemas";
import type { USDAClient } from "../clients/usda";

/**
 * Generic helper to enrich an array of items with USDA food data: extract a
 * lookup param per item (fdc_id or UPC — see foodLookupParamFromProduct), batch
 * fetch, and map results back. Items without a valid param get `food: null`.
 */
export async function batchEnrichWithFood<T extends object>(
  items: T[],
  getLookupParam: (item: T) => FoodLookupParam | null,
  usdaClient: USDAClient,
): Promise<Array<T & { food: FoodSummary | null }>> {
  if (items.length === 0) {
    return [];
  }

  const lookupParams = items.map((item) => getLookupParam(item));
  const validLookups = lookupParams.filter(
    (param): param is NonNullable<typeof param> => param !== null,
  );

  const results =
    validLookups.length > 0
      ? await usdaClient.findFoodsBatch(validLookups)
      : [];

  // Walk the per-item params and the dense results in lockstep: each item with a
  // param consumes the next result; items without one stay null.
  let resultIndex = 0;
  return items.map((item, itemIndex) => ({
    ...item,
    food: lookupParams[itemIndex] ? (results[resultIndex++] ?? null) : null,
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
