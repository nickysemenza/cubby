import { describe, expect, it } from "vitest";
import { ai } from "./ai.functions";
import { relatedData } from "./related-data.functions";

describe("AI and related-data Start contracts", () => {
  it("preserves the established cache key shapes", () => {
    expect(
      ai.suggestCategory.queryOptions({
        productName: "Cordless drill",
        manufacturer: "Example",
      }).queryKey,
    ).toEqual([
      "operation",
      "ai.suggestCategory",
      {
        input: { productName: "Cordless drill", manufacturer: "Example" },
      },
    ]);
    expect(ai.usageSummary.queryOptions({ days: 7 }).queryKey).toEqual([
      "operation",
      "ai.usageSummary",
      { input: { days: 7 } },
    ]);
    expect(
      relatedData.branch.queryOptions({
        relationKey: "vendor.products",
        sourceId: "VEN-4K7M",
        limit: 25,
      }).queryKey,
    ).toEqual([
      "operation",
      "relatedData.branch",
      {
        input: {
          relationKey: "vendor.products",
          sourceId: "VEN-4K7M",
          limit: 25,
        },
      },
    ]);
    expect(
      relatedData.summary.infiniteQueryOptions(
        {
          relationKey: "vendor.products",
          sourceId: "VEN-4K7M",
          offset: 0,
          limit: 25,
        },
        {
          page: (input, offset) => ({ ...input, offset }),
          getNextPageParam: (page) => page.nextOffset ?? undefined,
        },
      ).queryKey,
    ).toEqual([
      "operation",
      "relatedData.summary",
      "infinite",
      {
        input: {
          relationKey: "vendor.products",
          sourceId: "VEN-4K7M",
          limit: 25,
          offset: 0,
        },
      },
    ]);
  });

  it("marks every helper as an observed Start operation", () => {
    for (const options of [
      ai.suggestCategory.queryOptions({
        productName: "Cordless drill",
        manufacturer: "Example",
      }),
      ai.usageSummary.queryOptions({ days: 7 }),
      ai.describeLocation.mutationOptions(),
    ]) {
      expect(options.meta).toMatchObject({
        transport: "start",
        observedByTransport: true,
      });
    }
  });
});
