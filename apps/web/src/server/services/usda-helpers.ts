import type { FoodLookupParam, FoodSummary } from "@cubby/usda-schemas";

import type { USDAClient } from "../clients/usda";

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

  const allNested: TNested[] = [];
  const countsPerParent: number[] = [];

  parents.forEach((parent) => {
    const nested = getNestedItems(parent);
    countsPerParent.push(nested.length);
    allNested.push(...nested);
  });

  const allEnriched = await enrichFn(allNested);

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
