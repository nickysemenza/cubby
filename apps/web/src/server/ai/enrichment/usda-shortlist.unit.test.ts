import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { describe, expect, it } from "vitest";

import type { UsdaLookupPort } from "./usda-shortlist";
import {
  buildUsdaShortlist,
  usdaFoodSpec,
  usdaQueryVariants,
} from "./usda-shortlist";

// Real WASM (vitest inlines it), not a stub — these pin the actual grammar
// output the variants are derived from.
describe("usdaQueryVariants", () => {
  it("returns the verbatim text, the parser's cleaned name, and the head noun", () => {
    const variants = usdaQueryVariants("2 cups all-purpose flour, sifted");

    expect(variants).toEqual([
      "2 cups all-purpose flour, sifted",
      "all-purpose flour",
      "flour",
    ]);
  });

  it("collapses to one variant when verbatim, parsed name, and head noun all agree", () => {
    expect(usdaQueryVariants("salt")).toEqual(["salt"]);
  });
});

type FoodOverrides = Partial<FoodSummaryWithLinkedProducts> & {
  fdc_id: number;
  description: string;
};

function food(overrides: FoodOverrides): FoodSummaryWithLinkedProducts {
  const { fdc_id, description, ...rest } = overrides;
  return {
    fdc_id,
    description,
    foodInfo: { data_type: "sr_legacy_food", description },
    legacyFoodInfo: { ndb_number: 1100 },
    brandedFoodInfo: null,
    nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
    portionInfoRaw: [],
    inferredUnitMappings: [],
    linkedProducts: [],
    ...rest,
  };
}

function lookupReturning(
  byQuery: Record<string, FoodSummaryWithLinkedProducts[]>,
): UsdaLookupPort {
  return {
    listFoods: async (nameFilter) => {
      const data = (nameFilter && byQuery[nameFilter]) || [];
      return { data, count: data.length };
    },
  };
}

describe("buildUsdaShortlist", () => {
  it("merges variant results in order, dedupes by fdc_id, and drops unlinkable foods", async () => {
    const wholeFlour = food({
      fdc_id: 1001,
      description: "Wheat flour, whole-grain",
    });
    const apFlour = food({
      fdc_id: 1002,
      description: "Wheat flour, white, all-purpose",
    });
    const brandedFlour = food({
      fdc_id: 1003,
      description: "ALL PURPOSE FLOUR",
      legacyFoodInfo: null,
      brandedFoodInfo: {
        brand_owner: "King Arthur",
        brand_name: null,
        branded_food_category: null,
        gtin_upc: "000000000001",
        ingredients: null,
        serving: {
          serving_size: null,
          serving_size_unit: null,
          household_serving_fulltext: null,
        },
      },
      foodInfo: { data_type: "branded_food", description: "ALL PURPOSE FLOUR" },
    });
    const unlinkable = food({
      fdc_id: 1004,
      description: "Flour, foundation",
      legacyFoodInfo: null,
      foodInfo: {
        data_type: "foundation_food",
        description: "Flour, foundation",
      },
    });

    const usdaService = lookupReturning({
      "2 cups all-purpose flour, sifted": [wholeFlour],
      "all-purpose flour": [apFlour, wholeFlour],
      flour: [unlinkable, brandedFlour],
    });

    const shortlist = await buildUsdaShortlist(
      usdaService,
      "2 cups all-purpose flour, sifted",
    );

    // Variant order first (1001 from v0), then v1's own new hit (1002),
    // v1's repeat of 1001 dropped, then v2's linkable hit (1003). The
    // foundation_food (1004) has no NDB or UPC, so it is never offered as a
    // choice the model could pick but Cubby could not link.
    expect(shortlist.map((entry) => entry.fdcId)).toEqual([1001, 1002, 1003]);
    expect(shortlist[0]?.line).toBe(
      "FDC 1001 [sr_legacy_food]: Wheat flour, whole-grain",
    );
    // Branded: linkable via UPC, and the brand owner is appended.
    expect(shortlist[2]?.line).toBe(
      "FDC 1003 [branded_food, King Arthur]: ALL PURPOSE FLOUR",
    );
  });

  it("caps the merged shortlist at the limit", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      food({ fdc_id: i, description: `Food ${i}` }),
    );
    const usdaService = lookupReturning({ salt: many });

    const shortlist = await buildUsdaShortlist(usdaService, "salt", 25);

    expect(shortlist).toHaveLength(25);
  });

  it("runs only as many searches as there are variants", async () => {
    let calls = 0;
    const usdaService: UsdaLookupPort = {
      listFoods: async () => {
        calls += 1;
        return { data: [], count: 0 };
      },
    };

    await buildUsdaShortlist(usdaService, "salt");

    expect(calls).toBe(1);
  });
});

describe("usdaFoodSpec", () => {
  it("uses the fdcId as the selection id", () => {
    const entry = {
      fdcId: 1001,
      line: "FDC 1001 [sr_legacy_food]: Wheat flour",
      food: food({ fdc_id: 1001, description: "Wheat flour" }),
    };
    expect(usdaFoodSpec.idOf(entry)).toBe("1001");
    expect(usdaFoodSpec.renderLine(entry)).toBe(entry.line);
  });
});
