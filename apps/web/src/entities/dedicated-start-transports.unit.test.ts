import { describe, expect, it } from "vitest";
import {
  backgroundBatch,
  backgroundJob,
} from "~/lib/background-batch.functions";
import { cookbook } from "./cookbook.functions";
import { image } from "./image.functions";
import { usdaFood } from "./usda.functions";

describe("dedicated Start browser transports", () => {
  it("uses entity-owned canonical query keys", () => {
    const imageListInput = {
      filters: {},
      sort: { orderBy: "createdAt" as const, direction: "desc" as const },
      pagination: { pageIndex: 0, pageSize: 10 },
    };
    expect(image.list.queryOptions(imageListInput).queryKey).toEqual([
      "operation",
      "image.list",
      { input: imageListInput },
    ]);
    expect(image.detail.queryOptions({ id: "IMG-4K7M" }).queryKey).toEqual([
      "operation",
      "image.detail",
      { input: { id: "IMG-4K7M" } },
    ]);
    expect(
      image.projectSummaries.queryOptions({ projectIds: ["PRJ-4K7M"] })
        .queryKey,
    ).toEqual([
      "operation",
      "image.projectSummaries",
      { input: { projectIds: ["PRJ-4K7M"] } },
    ]);

    const usdaListInput = {
      filters: {},
      sort: { orderBy: "fdc_id" as const, direction: "desc" as const },
      pagination: { pageIndex: 0, pageSize: 10 },
    };
    expect(usdaFood.list.queryOptions(usdaListInput).queryKey).toEqual([
      "operation",
      "usda-food.list",
      { input: usdaListInput },
    ]);
    expect(usdaFood.detail.queryOptions({ id: 123 }).queryKey).toEqual([
      "operation",
      "usda-food.detail",
      { input: { id: 123 } },
    ]);
    expect(
      usdaFood.alternateId.queryOptions({ kind: "ndb", ndb_number: 123 }),
    ).toMatchObject({
      queryKey: [
        "operation",
        "usda-food.alternateId",
        { input: { kind: "ndb", ndb_number: 123 } },
      ],
    });

    expect(cookbook.list.queryOptions(null).queryKey).toEqual([
      "operation",
      "cookbook.list",
      { input: null },
    ]);
    expect(
      cookbook.detail.queryOptions({ shortcode: "not-yet-validated" }).queryKey,
    ).toEqual([
      "operation",
      "cookbook.detail",
      { input: { shortcode: "not-yet-validated" } },
    ]);
    expect(
      backgroundBatch.summary.queryOptions({ batchId: "batch-1" }).queryKey,
    ).toEqual([
      "operation",
      "background-batch.summary",
      { input: { batchId: "batch-1" } },
    ]);
    expect(backgroundBatch.list.queryOptions({ limit: 25 }).queryKey).toEqual([
      "operation",
      "background-batch.list",
      { input: { limit: 25 } },
    ]);
    expect(
      backgroundBatch.jobs.queryOptions({
        batchId: "batch-1",
        pageIndex: 0,
        pageSize: 100,
        failedOnly: false,
      }).queryKey,
    ).toEqual([
      "operation",
      "background-batch.jobs",
      {
        input: {
          batchId: "batch-1",
          pageIndex: 0,
          pageSize: 100,
          failedOnly: false,
        },
      },
    ]);
  });

  it("marks every helper as an observed Start operation", () => {
    const queries = [
      image.detail.queryOptions({ id: "IMG-4K7M" }),
      usdaFood.detail.queryOptions({ id: 123 }),
      usdaFood.alternateId.queryOptions({ kind: "upc", gtin_upc: "123" }),
      cookbook.list.queryOptions(null),
      cookbook.detail.queryOptions({ shortcode: "CKB-4K7M" }),
      backgroundBatch.summary.queryOptions({ batchId: "batch-1" }),
      backgroundBatch.list.queryOptions({ limit: 25 }),
      backgroundBatch.jobs.queryOptions({
        batchId: "batch-1",
        pageIndex: 0,
        pageSize: 100,
        failedOnly: false,
      }),
    ];
    for (const query of queries) {
      expect(query.meta).toMatchObject({
        transport: "start",
        observedByTransport: true,
      });
    }

    expect(image.update.mutationOptions().meta).toMatchObject({
      transport: "start",
      operation: "image.update",
      observedByTransport: true,
    });
    expect(image.delete.mutationOptions().meta).toMatchObject({
      transport: "start",
      operation: "image.delete",
      observedByTransport: true,
    });
    for (const mutation of [
      backgroundBatch.retry.mutationOptions(),
      backgroundJob.retry.mutationOptions(),
      backgroundBatch.cancel.mutationOptions(),
      backgroundJob.drain.mutationOptions(),
    ]) {
      expect(mutation.meta).toMatchObject({
        transport: "start",
        observedByTransport: true,
      });
    }
  });
});
