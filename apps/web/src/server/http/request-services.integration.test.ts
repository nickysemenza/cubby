import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { foodSummary, type FoodSummary } from "@cubby/usda";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import { USDAClient } from "~/server/clients/usda";
import type { UsdaReleaseRpc } from "~/server/domains/usda-release/operations/rpc";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { buildRequestServices } from "./request-services";

const food = (fdc_id: number, barcode?: string): FoodSummary => {
  const row = mock(foodSummary, { seed: fdc_id });
  return {
    ...row,
    fdc_id,
    brandedFoodInfo: barcode
      ? {
          brand_owner: null,
          brand_name: null,
          branded_food_category: null,
          gtin_upc: barcode,
          ingredients: null,
          serving: {
            serving_size: null,
            serving_size_unit: null,
            household_serving_fulltext: null,
          },
        }
      : null,
  };
};

describe("request USDA linked Product reads", () => {
  const ctx = withTestDb();

  it("projects authoritative Product envelopes while retaining duplicate and empty food groups", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic linked pantry food",
        price: 13,
        fdc_id: 880001,
        barcode: "012345678905",
      }),
      ctx.actor,
    );
    const foods = [food(880001), food(880002, "0012345678905"), food(880003)];
    const read = (repetitions: number) => {
      const rows = Array.from({ length: repetitions }, () => foods).flat();
      const client = new USDAClient(
        fromPartial<UsdaReleaseRpc>({
          search: async () => ({ data: rows, count: rows.length }),
          lookupBatch: async (
            lookups: Parameters<UsdaReleaseRpc["lookupBatch"]>[0],
          ) =>
            lookups.map((lookup) =>
              lookup.kind === "fdc"
                ? (foods.find((row) => row.fdc_id === lookup.fdc_id) ?? null)
                : null,
            ),
        }),
      );
      const { usdaService } = buildRequestServices(ctx.db, client);
      return usdaService.listFoods(
        undefined,
        undefined,
        { orderBy: "relevance", direction: "asc" },
        { pageIndex: 0, pageSize: rows.length },
      );
    };
    const repeated = await read(20);
    expect(
      repeated.data.map((row) => row.linkedProducts.map((item) => item.id)),
    ).toEqual(
      Array.from({ length: 20 }, () => [[product.id], [product.id], []]).flat(),
    );
    expect(repeated.data.map((row) => row.fdc_id)).toEqual(
      Array.from({ length: 20 }, () => foods.map((row) => row.fdc_id)).flat(),
    );
    const linked = repeated.data[0]?.linkedProducts[0];
    expect(linked).toBeDefined();
    if (!linked) return;
    expect(fieldValueOf(linked.fields.price)).toBe(13);
    expect(linked.fields.price.current.assignment).toMatchObject({
      kind: "value",
      value: 13,
    });
    expect(linked).not.toHaveProperty("price");
    expect(linked.pricing).not.toHaveProperty("effectivePrice");
    expect(linked.pricing).not.toHaveProperty("derivedPrice");
    expect(linked).not.toHaveProperty("brandName");
    expect(linked).not.toHaveProperty("fieldResolutions");
    expect(linked).not.toHaveProperty("derived");
    const { usdaService } = buildRequestServices(
      ctx.db,
      new USDAClient(
        fromPartial<UsdaReleaseRpc>({
          lookupBatch: async (
            lookups: Parameters<UsdaReleaseRpc["lookupBatch"]>[0],
          ) => lookups.map(() => foods[0] ?? null),
        }),
      ),
    );
    const detail = await usdaService.getFoodSummaryByID(880001);
    expect(detail?.linkedProducts.map((item) => item.id)).toEqual([product.id]);
    expect(
      detail?.linkedProducts[0]?.fields.price.current.assignment,
    ).toMatchObject({ kind: "value", value: 13 });
  });
});
