import { describe, expect, it, vi } from "vitest";

import type { Database } from "~/server/db";
import {
  PartialUpcBatchLookupError,
  UpcBatchDeferredError,
} from "~/server/repo/upc-lookup-cache";

import { UpcLookupService } from ".";

const found = {
  status: "found" as const,
  data: {
    name: "Synthetic item",
    manufacturer: null,
    brand: null,
    category: null,
    description: null,
    priceDollars: null,
    imageUrl: null,
    source: "upcitemdb" as const,
    sourceData: "{}",
  },
};

describe("UpcLookupService.lookupBatch", () => {
  it("reports deterministic deferral with completed results after the pass budget", async () => {
    const upstream = vi.fn(async () => found);
    const service = new UpcLookupService(
      {} as Database,
      upstream,
      async () => [],
    );

    let deferred: UpcBatchDeferredError | undefined;
    try {
      await service.lookupBatch(
        Array.from({ length: 26 }, (_, index) => `upc-${index}`),
      );
    } catch (error) {
      if (error instanceof UpcBatchDeferredError) deferred = error;
      else throw error;
    }

    expect(upstream).toHaveBeenCalledTimes(25);
    expect(deferred?.completedUpcs).toHaveLength(25);
    expect(deferred?.results).toHaveProperty("size", 25);
    expect(deferred?.failedUpcs).toEqual(["upc-25"]);
  });

  it("keeps provider failures distinct from deterministic deferral", async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(found)
      .mockResolvedValueOnce({
        status: "error" as const,
        error: new Error("synthetic provider outage"),
      });
    const service = new UpcLookupService(
      {} as Database,
      upstream,
      async () => [],
    );

    const failure = service.lookupBatch(["upc-1", "upc-2", "upc-3"]);
    await expect(failure).rejects.toBeInstanceOf(PartialUpcBatchLookupError);
    await expect(failure).rejects.toMatchObject({
      message: "synthetic provider outage",
      failedUpcs: ["upc-2", "upc-3"],
    });
  });
});
