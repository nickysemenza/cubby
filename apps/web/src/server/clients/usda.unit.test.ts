import type { FoodLookupParam, FoodSummary } from "@cubby/usda";
import type { FoodSearchArgs } from "@cubby/usda/release";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import type { UsdaReleaseRpc } from "~/server/usda-release/rpc";

import { USDAClient } from "./usda";

const food = (fdc_id: number) => fromPartial<FoodSummary>({ fdc_id });

function fakeRelease(
  lookupBatch: UsdaReleaseRpc["lookupBatch"],
  search: UsdaReleaseRpc["search"] = async () => ({ data: [], count: 0 }),
) {
  return fromPartial<UsdaReleaseRpc>({
    lookupBatch: vi.fn(lookupBatch),
    search: vi.fn(search),
  });
}

describe("USDAClient.findFoodsBatch request-scoped memo", () => {
  it("reuses earlier results and only asks the release for unseen lookups", async () => {
    const release = fakeRelease(async (lookups) =>
      lookups.map((lookup) => food(lookup.kind === "fdc" ? lookup.fdc_id : 1)),
    );
    const client = new USDAClient(release);
    expect(
      await client.findFoodsBatch([{ kind: "upc", gtin_upc: "012345678905" }]),
    ).toEqual([food(1)]);

    expect(
      await client.findFoodsBatch([
        { kind: "upc", gtin_upc: "012345678905" },
        { kind: "fdc", fdc_id: 2 },
      ]),
    ).toEqual([food(1), food(2)]);
    expect(release.lookupBatch).toHaveBeenCalledTimes(2);
    expect(release.lookupBatch).toHaveBeenLastCalledWith([
      { kind: "fdc", fdc_id: 2 },
    ]);
  });

  it("does not ask again for a known miss within the request", async () => {
    const release = fakeRelease(async (lookups) => lookups.map(() => null));
    const client = new USDAClient(release);
    const lookup = { kind: "ndb", ndb_number: 999 } satisfies FoodLookupParam;
    expect(await client.findFoodsBatch([lookup])).toEqual([null]);
    expect(await client.findFood(lookup)).toBeNull();
    expect(release.lookupBatch).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent calls for the same lookup onto one release call", async () => {
    // The Problems page runs two detectors over overlapping products under one
    // Promise.all; the memo holds the in-flight promise so they share a call.
    const release = fakeRelease(
      (lookups) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(lookups.map(() => food(7))), 10),
        ),
    );
    const client = new USDAClient(release);
    const lookup = {
      kind: "upc",
      gtin_upc: "012345678905",
    } satisfies FoodLookupParam;
    const [a, b] = await Promise.all([
      client.findFoodsBatch([lookup]),
      client.findFood(lookup),
    ]);
    expect(a).toEqual([food(7)]);
    expect(b).toEqual(food(7));
    expect(release.lookupBatch).toHaveBeenCalledOnce();
  });

  it("surfaces the release's own error, such as a release still loading", async () => {
    const client = new USDAClient(
      fakeRelease(async () => {
        throw new Error("USDA release 2000-01 is loading: 1/4 shards");
      }),
    );
    await expect(
      client.findFood({ kind: "fdc", fdc_id: 3 }),
    ).rejects.toThrowError("USDA release 2000-01 is loading: 1/4 shards");
  });
});

describe("USDAClient.listFoods", () => {
  it("maps a generic sort and page onto one release search", async () => {
    const release = fakeRelease(
      async () => [],
      async () => ({ data: [], count: 12 }),
    );
    const result = await new USDAClient(release).listFoods(
      "oats",
      undefined,
      { orderBy: "name", direction: "desc" },
      { pageIndex: 2, pageSize: 5 },
      true,
      ["foundation_food", "sr_legacy_food"],
    );
    expect(result).toEqual({ data: [], count: 12 });
    expect(release.search).toHaveBeenCalledWith({
      nameFilter: "oats",
      dataTypeFilter: undefined,
      dataTypes: ["foundation_food", "sr_legacy_food"],
      foodsOnly: true,
      orderBy: "description",
      direction: "desc",
      pageIndex: 2,
      pageSize: 5,
    } satisfies FoodSearchArgs);
  });
});
