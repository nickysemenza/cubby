import { describe, expect, it } from "vitest";
import {
  aiUsageSummaryQueryOptions,
  describeLocationMutationOptions,
  suggestCategoryQueryOptions,
} from "./ai.functions";
import {
  relatedDataBranchQueryOptions,
  relatedDataSummaryInfiniteQueryOptions,
} from "./related-data.functions";

describe("AI and related-data Start contracts", () => {
  it("preserves the established cache key shapes", () => {
    expect(
      suggestCategoryQueryOptions({
        productName: "Cordless drill",
        manufacturer: "Example",
      }).queryKey,
    ).toEqual([
      ["ai", "suggestCategory"],
      {
        input: { productName: "Cordless drill", manufacturer: "Example" },
        type: "query",
      },
    ]);
    expect(aiUsageSummaryQueryOptions({ days: 7 }).queryKey).toEqual([
      ["ai", "usageSummary"],
      { input: { days: 7 }, type: "query" },
    ]);
    expect(
      relatedDataBranchQueryOptions({
        relationKey: "vendor.products",
        sourceId: "VEN-4K7M",
        limit: 25,
      }).queryKey,
    ).toEqual([
      ["relatedData", "branch"],
      {
        input: {
          relationKey: "vendor.products",
          sourceId: "VEN-4K7M",
          limit: 25,
        },
        type: "query",
      },
    ]);
    expect(
      relatedDataSummaryInfiniteQueryOptions({
        relationKey: "vendor.products",
        sourceId: "VEN-4K7M",
        limit: 25,
      }).queryKey,
    ).toEqual([
      ["relatedData", "summary"],
      {
        input: {
          relationKey: "vendor.products",
          sourceId: "VEN-4K7M",
          limit: 25,
          offset: 0,
        },
        type: "query",
      },
      "__infinite__",
    ]);
  });

  it("marks every helper as an observed Start operation", () => {
    for (const options of [
      suggestCategoryQueryOptions({
        productName: "Cordless drill",
        manufacturer: "Example",
      }),
      aiUsageSummaryQueryOptions({ days: 7 }),
      describeLocationMutationOptions(),
    ]) {
      expect(options.meta).toMatchObject({
        transport: "start",
        observedByTransport: true,
      });
    }
  });
});
