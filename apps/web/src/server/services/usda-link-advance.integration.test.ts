import type { FoodLookupParam, FoodSummary } from "@cubby/usda";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { USDAClient } from "~/server/clients/usda";
import { getProductByID } from "~/server/repo/product/crud";
import {
  createProductFixture,
  createSystemUserFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import type { UsdaReleaseRpc } from "~/server/usda-release/rpc";

import {
  advanceLinksWhenReady,
  advanceProductUsdaLinks,
} from "./usda-link-advance.service";

// A release where 9900101 was superseded by 9900105, 9900200 is current, and
// 9900300 is not in the release at all.
const CURRENT = new Map([
  [9900101, 9900105],
  [9900105, 9900105],
  [9900200, 9900200],
]);

const release = fromPartial<UsdaReleaseRpc>({
  lookupBatch: async (lookups: FoodLookupParam[]) =>
    lookups.map((lookup) => {
      const current =
        lookup.kind === "fdc" ? CURRENT.get(lookup.fdc_id) : undefined;
      return current === undefined
        ? null
        : fromPartial<FoodSummary>({
            fdc_id: current,
            foodInfo: { data_type: "branded_food", description: "Sample" },
            brandedFoodInfo: null,
            legacyFoodInfo: null,
            nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
            portionInfoRaw: [],
          });
    }),
});

describe("advanceProductUsdaLinks", () => {
  const ctx = withTestDb();

  it("moves superseded links to the current revision and leaves the rest", async () => {
    await createSystemUserFixture(ctx.db);
    const superseded = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Sample granola", fdc_id: 9900101 }),
      ctx.actor,
    );
    const current = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Sample oats", fdc_id: 9900200 }),
      ctx.actor,
    );
    const vanished = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Sample yogurt", fdc_id: 9900300 }),
      ctx.actor,
    );

    const advanced = await advanceProductUsdaLinks(
      ctx.db,
      new USDAClient(release),
    );

    expect(advanced).toEqual([
      { productId: superseded.entityId, fromFdcId: 9900101, toFdcId: 9900105 },
    ]);
    expect((await getProductByID(ctx.db, superseded.entityId)).fdc_id).toBe(
      9900105,
    );
    expect((await getProductByID(ctx.db, current.entityId)).fdc_id).toBe(
      9900200,
    );
    expect((await getProductByID(ctx.db, vanished.entityId)).fdc_id).toBe(
      9900300,
    );
    expect(
      await advanceProductUsdaLinks(ctx.db, new USDAClient(release)),
    ).toEqual([]);
  });

  it("reports a failed release load instead of skipping it", async () => {
    const failed = fromPartial<UsdaReleaseRpc>({
      status: async () =>
        fromPartial<Awaited<ReturnType<UsdaReleaseRpc["status"]>>>({
          release: "2000-01",
          state: "failed",
          error: "shard 3: unexpected end of gzip stream",
        }),
    });
    await expect(advanceLinksWhenReady(ctx.db, failed)).rejects.toThrowError(
      "USDA release 2000-01 failed to load: shard 3: unexpected end of gzip stream",
    );
  });
});
