import { SMART_COLLECTION_STARTERS } from "@cubby/schemas/collection";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

import { collection } from "./collection.functions";

describe("smart Collection cache contract", () => {
  it("revalidates both views after each relationship mutation", async () => {
    const client = new QueryClient();
    const definition = SMART_COLLECTION_STARTERS[0];
    if (!definition) throw new Error("Missing starter");
    const list = collection.smartList.queryOptions({
      definitions: [...SMART_COLLECTION_STARTERS],
    });
    const detail = collection.smartDetail.queryOptions({
      definition,
      pagination: { pageIndex: 0, pageSize: 25 },
    });
    client.getQueryCache().build(client, list);
    client.getQueryCache().build(client, detail);
    for (const invalidation of [
      ripple.product,
      ripple.location,
      ripple.locationReparent,
      ripple.inventory,
      ripple.expense,
      ripple.purchase,
    ]) {
      client.setQueryData(list.queryKey, []);
      client.setQueryData(detail.queryKey, {
        summary: {
          key: definition.key,
          name: definition.name,
          totalCount: 0,
          sourceCounts: {
            productTagEquals: 0,
            manufacturerEquals: 0,
            effectiveOwnerEquals: 0,
            categoryEquals: 0,
            locationNameContains: 0,
            historicalExpenseTrade: 0,
          },
        },
        products: [],
        totalCount: 0,
      });
      await invalidateOperationTags(client, invalidation);
      expect(client.getQueryState(list.queryKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(detail.queryKey)?.isInvalidated).toBe(true);
    }
    const edited = collection.smartDetail.queryOptions({
      definition: { ...definition, rules: [] },
      pagination: { pageIndex: 0, pageSize: 25 },
    });
    expect(edited.queryKey).not.toEqual(detail.queryKey);
    client.clear();
  });
});
