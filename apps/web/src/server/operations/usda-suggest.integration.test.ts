import { foodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import {
  suggestUsdaFoodsForProduct,
  type UsdaSuggestionPort,
} from "./usda.server";

const food = (fdc_id: number, description: string) =>
  mock(foodSummaryWithLinkedProducts, {
    overrides: { fdc_id, description },
  });

/**
 * A USDA port that answers only what a test scripts: barcode lookups by
 * `gtin_upc`, and name searches by the exact query string. Every call is
 * recorded so a test can assert what was (not) asked.
 */
const scriptedUsda = (script: {
  upc?: Record<string, ReturnType<typeof food>>;
  search?: Record<string, ReturnType<typeof food>[]>;
}) => {
  const searches: string[] = [];
  const lookups: string[] = [];
  const port: UsdaSuggestionPort = {
    findFood: async (lookup) => {
      if (lookup.kind !== "upc") throw new Error("only upc lookups scripted");
      lookups.push(lookup.gtin_upc);
      return script.upc?.[lookup.gtin_upc] ?? null;
    },
    listFoods: async (query) => {
      searches.push(query ?? "");
      const data = script.search?.[query ?? ""] ?? [];
      return { data, count: data.length };
    },
  };
  return { port, searches, lookups };
};

/**
 * Failure modes: a barcode hit is buried under name matches; a product with a
 * barcode but no USDA record never falls through to a name search; a
 * manufacturer-qualified search that finds nothing never retries on the bare
 * name; a barcode hit is repeated by the name search.
 */
describe("usda_food.suggest_for_product", () => {
  const ctx = withTestDb();

  it("returns the barcode match first, then name+manufacturer matches without repeating it", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Example Oat Flakes",
        manufacturer: "Sample Mills",
        upc: "012345678905",
      }),
      ctx.actor,
    );
    const byBarcode = food(1001, "Sample Mills Example Oat Flakes");
    const other = food(1002, "Oats, rolled, dry");
    const usda = scriptedUsda({
      upc: { "012345678905": byBarcode },
      search: {
        "Example Oat Flakes Sample Mills": [byBarcode, other],
      },
    });

    const suggestions = await suggestUsdaFoodsForProduct(
      { db: ctx.db, usdaService: usda.port },
      product.id,
    );

    expect(
      suggestions.candidates.map((c) => [c.reason, c.food.fdc_id]),
    ).toEqual([
      ["upc", 1001],
      ["name_manufacturer", 1002],
    ]);
    expect(suggestions.currentFdcId).toBeNull();
    expect(usda.lookups).toEqual(["012345678905"]);
  });

  it("falls through to the name search when the barcode has no USDA record", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Example Lentil Pasta",
        manufacturer: "Sample Mills",
        upc: "036000291452",
        fdc_id: 777001,
      }),
      ctx.actor,
    );
    const match = food(2001, "Lentil pasta, dry");
    const usda = scriptedUsda({
      search: { "Example Lentil Pasta Sample Mills": [match] },
    });

    const suggestions = await suggestUsdaFoodsForProduct(
      { db: ctx.db, usdaService: usda.port },
      product.id,
    );

    expect(
      suggestions.candidates.map((c) => [c.reason, c.food.fdc_id]),
    ).toEqual([["name_manufacturer", 2001]]);
    expect(suggestions.currentFdcId).toBe(777001);
  });

  it("retries on the bare name when the manufacturer-qualified search is empty", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Example Chickpea Flour",
        manufacturer: "Sample Mills",
      }),
      ctx.actor,
    );
    const match = food(3001, "Chickpea flour");
    const usda = scriptedUsda({
      search: { "Example Chickpea Flour": [match] },
    });

    const suggestions = await suggestUsdaFoodsForProduct(
      { db: ctx.db, usdaService: usda.port },
      product.id,
    );

    expect(usda.searches).toEqual([
      "Example Chickpea Flour Sample Mills",
      "Example Chickpea Flour",
    ]);
    expect(
      suggestions.candidates.map((c) => [c.reason, c.food.fdc_id]),
    ).toEqual([["name", 3001]]);
  });
});
