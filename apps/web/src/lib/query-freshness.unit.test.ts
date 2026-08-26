import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { calendar } from "~/app/calendar/calendar.functions";
import { location } from "~/app/locations/location.functions";
import { entityDetailQueryOptions } from "~/entities/entity-detail.functions";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";

describe("operation freshness metadata", () => {
  it("keeps stable details and indexes warm through their descriptors", () => {
    const detail = entityDetailQueryOptions("product", "PRD-2222");
    const tree = location.makeTree.queryOptions();

    expect(detail).toMatchObject({ staleTime: 300_000, gcTime: 86_400_000 });
    expect(detail.meta).toMatchObject({ persistence: "persist" });
    expect(tree).toMatchObject({ staleTime: 120_000 });
    expect(tree.meta).toMatchObject({ persistence: "memory" });
  });
});

describe("operation-tag invalidation", () => {
  it("matches normalized operation queries through descriptor metadata", async () => {
    const client = new QueryClient();
    const options = calendar.range.queryOptions({
      startDate: "2026-07-01",
      endDateExclusive: "2026-08-01",
    });
    const query = client.getQueryCache().build(client, options);
    query.setData({ items: [], days: {} });

    await invalidateOperationTags(client, [["calendar"]]);

    expect(query.state.isInvalidated).toBe(true);
  });
});
