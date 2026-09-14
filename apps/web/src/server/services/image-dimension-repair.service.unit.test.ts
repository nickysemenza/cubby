import { testEntityId } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";

import { repairImageDimensions } from "./image-dimension-repair.service";

const row = (name: string) => ({
  id: testEntityId("image", name),
  key: `images/${name}.jpg`,
  contentType: "image/jpeg",
  size: 100,
  width: null,
  height: null,
  detectedContentType: null,
  sha256: null,
});

describe("repairImageDimensions", () => {
  // SAFETY: Every database interaction is replaced by the injected ports; the
  // service only forwards this opaque value to them.
  const database = {} as Database;

  it("runs bounded full-verification batches and reports progress", async () => {
    const pages = [[row("first"), row("second")], [row("third")]];
    let page = 0;
    const result = await repairImageDimensions(
      database,
      { batchSize: 2, maxBatches: 5 },
      {
        select: async () => pages[page++] ?? [],
        verify: async (_db, rows) =>
          rows.map(({ id }, index) => ({
            imageId: id,
            storageStatus:
              page === 1 && index === 1
                ? ("metadata_mismatch" as const)
                : ("available" as const),
          })),
        count: async () => 0,
      },
    );

    expect(result).toEqual({
      batches: 2,
      scanned: 3,
      repaired: 2,
      failed: 1,
      remaining: 0,
      stopped: "complete",
    });
  });

  it("stops when a verifier cannot advance the selected page", async () => {
    const result = await repairImageDimensions(
      database,
      { batchSize: 1, maxBatches: 5 },
      {
        select: async () => [row("stuck")],
        verify: async () => [],
        count: async () => 1,
      },
    );
    expect(result.stopped).toBe("no_progress");
    expect(result.batches).toBe(1);
  });

  it("stops when verification returns a result but selects the same row again", async () => {
    let verifies = 0;
    const result = await repairImageDimensions(
      database,
      { batchSize: 1, maxBatches: 5 },
      {
        select: async () => [row("still-missing-dimensions")],
        verify: async (_db, rows) => {
          verifies += 1;
          return rows.map(({ id }) => ({
            imageId: id,
            storageStatus: "available" as const,
          }));
        },
        count: async () => 1,
      },
    );
    expect(result.stopped).toBe("no_progress");
    expect(result.batches).toBe(1);
    expect(verifies).toBe(1);
  });
});
