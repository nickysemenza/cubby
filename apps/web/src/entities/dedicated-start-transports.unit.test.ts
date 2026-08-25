import { describe, expect, it } from "vitest";
import { backgroundBatchSummaryQueryOptions } from "~/lib/background-batch.functions";
import {
  cookbookDetailQueryOptions,
  cookbookListQueryOptions,
} from "./cookbook.functions";
import {
  imageDeleteMutationOptions,
  imageDetailQueryOptions,
  imageListQueryOptions,
  imageUpdateMutationOptions,
  projectImageSummariesQueryOptions,
} from "./image.functions";
import {
  usdaFoodDetailQueryOptions,
  usdaFoodListQueryOptions,
} from "./usda.functions";

describe("dedicated Start browser transports", () => {
  it("uses entity-owned canonical query keys", () => {
    const imageListInput = {
      filters: {},
      sort: { orderBy: "createdAt" as const, direction: "desc" as const },
      pagination: { pageIndex: 0, pageSize: 10 },
    };
    expect(imageListQueryOptions(imageListInput).queryKey).toEqual([
      ["image", "list"],
      { input: imageListInput },
    ]);
    expect(imageDetailQueryOptions("IMG-4K7M").queryKey).toEqual([
      ["image", "detail"],
      { shortcode: "IMG-4K7M" },
    ]);
    expect(
      projectImageSummariesQueryOptions({ projectIds: ["PRJ-4K7M"] }).queryKey,
    ).toEqual([["image", "projectSummaries"], { projectIds: ["PRJ-4K7M"] }]);

    const usdaListInput = {
      filters: {},
      sort: { orderBy: "fdc_id" as const, direction: "desc" as const },
      pagination: { pageIndex: 0, pageSize: 10 },
    };
    expect(usdaFoodListQueryOptions(usdaListInput).queryKey).toEqual([
      ["usda-food", "list"],
      { input: usdaListInput },
    ]);
    expect(usdaFoodDetailQueryOptions(123).queryKey).toEqual([
      ["usda-food", "detail"],
      { id: 123 },
    ]);

    expect(cookbookListQueryOptions().queryKey).toEqual([["cookbook", "list"]]);
    expect(cookbookDetailQueryOptions("not-yet-validated").queryKey).toEqual([
      ["cookbook", "detail"],
      { shortcode: "not-yet-validated" },
    ]);
    expect(
      backgroundBatchSummaryQueryOptions({ batchId: "batch-1" }).queryKey,
    ).toEqual([["background-batch", "summary"], { batchId: "batch-1" }]);
  });

  it("marks every helper as an observed Start operation", () => {
    const queries = [
      imageDetailQueryOptions("IMG-4K7M"),
      usdaFoodDetailQueryOptions(123),
      cookbookListQueryOptions(),
      cookbookDetailQueryOptions("CKB-4K7M"),
      backgroundBatchSummaryQueryOptions({ batchId: "batch-1" }),
    ];
    for (const query of queries) {
      expect(query.meta).toMatchObject({
        transport: "start",
        observedByTransport: true,
      });
    }

    expect(imageUpdateMutationOptions().meta).toMatchObject({
      transport: "start",
      operation: "image.update",
      observedByTransport: true,
    });
    expect(imageDeleteMutationOptions().meta).toMatchObject({
      transport: "start",
      operation: "image.delete",
      observedByTransport: true,
    });
  });
});
