import { parseEntityId } from "@cubby/schemas/identifiers";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { UPCLookupResponse } from "@cubby/upc-contract";
import type { FoodSummary } from "@cubby/usda-schemas";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { UpcLookupPort } from "~/server/clients/upc-lookup";
import type { UsdaFoodLookupPort } from "~/server/clients/usda";
import { quickCreateProduct } from "~/server/repo/product";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

import { LocationValuationService } from "./location-valuation.service";
import {
  applyUpcDataWithSideEffects,
  findOrCreateByCode,
  findOrCreateByUPC,
} from "./product-orchestration.service";
import { createProductWriteActions } from "./product.service";
import { RecipeCostingService } from "./recipe-costing.service";
import type { UsdaFoodBatchPort } from "./usda-helpers";

// Fakes never hit the network — `findFood`/`lookup` are the only methods the
// cascade calls, so a plain object stands in for the concrete client classes.
const fakeUsdaClient = (
  findFood: UsdaFoodLookupPort["findFood"] = async () => null,
): UsdaFoodLookupPort & UsdaFoodBatchPort => {
  const findOne = vi.fn(findFood);
  return {
    findFood: findOne,
    findFoodsBatch: vi.fn(async (lookups) => Promise.all(lookups.map(findOne))),
  };
};

const fakeUpcLookupClient = (
  lookup: (upc: string) => Promise<UPCLookupResponse | null> = async () => null,
): UpcLookupPort => {
  const single = vi.fn(lookup);
  return {
    lookup: single,
    lookupBatch: vi.fn(async (upcs: string[]) => {
      const entries = await Promise.all(
        upcs.map(async (upc) => [upc, await single(upc)] as const),
      );
      return new Map(
        entries.filter(
          (entry): entry is readonly [string, UPCLookupResponse] =>
            entry[1] != null,
        ),
      );
    }),
  };
};

const upcResponse = (
  overrides: Partial<UPCLookupResponse> = {},
): UPCLookupResponse => ({
  upc: "000000000000",
  name: "Widget Deluxe",
  manufacturer: "Widget Co",
  brand: null,
  category: null,
  description: null,
  priceDollars: null,
  imageUrl: null,
  source: "upcitemdb",
  cached: false,
  ...overrides,
});

const usdaFood = (overrides: Partial<FoodSummary> = {}): FoodSummary => ({
  fdc_id: 111111,
  foodInfo: { data_type: "branded_food", description: "Store Brand Salt" },
  brandedFoodInfo: {
    brand_owner: "Acme",
    brand_name: null,
    branded_food_category: null,
    gtin_upc: "022222222222",
    ingredients: null,
    serving: {
      serving_size: null,
      serving_size_unit: null,
      household_serving_fulltext: null,
    },
  },
  legacyFoodInfo: null,
  nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
  portionInfoRaw: [],
  ...overrides,
});

describe("findOrCreateByUPC", () => {
  const ctx = withTestDb();

  it("branch 1: returns the existing product without calling USDA or the UPC worker", async () => {
    const upc = "011111111111";
    const existing = await quickCreateProduct(
      ctx.db,
      { name: "Existing Widget", upc },
      ctx.actor,
    );
    const usdaClient = fakeUsdaClient();
    const upcLookupClient = fakeUpcLookupClient();

    const result = await findOrCreateByUPC(
      ctx.db,
      usdaClient,
      upcLookupClient,
      upc,
      undefined,
      ctx.actor,
    );

    expect(result).toEqual({ product: existing, created: false });
    expect(usdaClient.findFood).not.toHaveBeenCalled();
    expect(upcLookupClient.lookup).not.toHaveBeenCalled();
  });

  it("branch 2: creates from a USDA match when no local product exists", async () => {
    const upc = "022222222222";
    const food = usdaFood({ fdc_id: 222222 });
    const usdaClient = fakeUsdaClient(async () => food);
    const upcLookupClient = fakeUpcLookupClient();

    const result = await findOrCreateByUPC(
      ctx.db,
      usdaClient,
      upcLookupClient,
      upc,
      undefined,
      ctx.actor,
    );

    expect(result.created).toBe(true);
    expect(result.product.name).toBe("Store Brand Salt");
    expect(result.product.manufacturer).toBe("Acme");
    expect(result.product.primaryGtin).toBe(upc.padStart(14, "0"));
    expect(upcLookupClient.lookup).not.toHaveBeenCalled();
  });

  it("branch 3: falls back to the UPC worker when USDA has no match", async () => {
    const upc = "033333333333";
    const usdaClient = fakeUsdaClient();
    const upcLookupClient = fakeUpcLookupClient(async () =>
      upcResponse({
        upc,
        name: "Widget Deluxe",
        manufacturer: "Widget Co",
        priceDollars: 4.99,
      }),
    );

    const result = await findOrCreateByUPC(
      ctx.db,
      usdaClient,
      upcLookupClient,
      upc,
      undefined,
      ctx.actor,
    );

    expect(result.created).toBe(true);
    expect(result.product.name).toBe("Widget Deluxe");
    expect(result.product.manufacturer).toBe("Widget Co");
    expect(result.product.price).toBe(4.99);
  });

  it("branch 4: creates a default product when nothing is found anywhere", async () => {
    const upc = "044444444444";
    const usdaClient = fakeUsdaClient();
    const upcLookupClient = fakeUpcLookupClient();

    const result = await findOrCreateByUPC(
      ctx.db,
      usdaClient,
      upcLookupClient,
      upc,
      "Fallback Name",
      ctx.actor,
    );

    expect(result.created).toBe(true);
    expect(result.product.name).toBe("Fallback Name");
    expect(result.product.manufacturer).toBe(UNSPECIFIED_MANUFACTURER);
    expect(result.product.primaryGtin).toBe(upc.padStart(14, "0"));
  });

  it("branch 4: defaults the name to 'Product <upc>' when no defaultName is given", async () => {
    const upc = "055555555555";
    const result = await findOrCreateByUPC(
      ctx.db,
      fakeUsdaClient(),
      fakeUpcLookupClient(),
      upc,
      undefined,
      ctx.actor,
    );

    expect(result.product.name).toBe(`Product ${upc}`);
  });

  it("resolves a concurrent create race to one winner without throwing", async () => {
    const upc = "066666666666";
    const usdaClient = fakeUsdaClient();
    const upcLookupClient = fakeUpcLookupClient();

    // Two truly-concurrent callers for a brand-new UPC: both pass the initial
    // findProductByUPC check, then race on the create — runWithConflictRecovery
    // must convert the loser's unique-violation into a re-SELECT of the
    // winner instead of surfacing a 500.
    const [a, b] = await Promise.all([
      findOrCreateByUPC(
        ctx.db,
        usdaClient,
        upcLookupClient,
        upc,
        "Race Product",
        ctx.actor,
      ),
      findOrCreateByUPC(
        ctx.db,
        usdaClient,
        upcLookupClient,
        upc,
        "Race Product",
        ctx.actor,
      ),
    ]);

    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.product.id).toBe(b.product.id);
  });
});

describe("findOrCreateByCode", () => {
  const ctx = withTestDb();

  it("returns an existing ISBN-backed Product without external lookups", async () => {
    const isbn = "09780131103627";
    const existing = await quickCreateProduct(
      ctx.db,
      { name: "Existing Book", isbn },
      ctx.actor,
    );
    const usdaClient = fakeUsdaClient();
    const upcLookupClient = fakeUpcLookupClient();

    const result = await findOrCreateByCode(
      ctx.db,
      usdaClient,
      upcLookupClient,
      { kind: "isbn", value: isbn },
      ctx.actor,
    );

    expect(result).toEqual({ product: existing, created: false });
    expect(usdaClient.findFood).not.toHaveBeenCalled();
    expect(upcLookupClient.lookup).not.toHaveBeenCalled();
  });

  it("creates an ISBN provider match as a books Product without querying USDA", async () => {
    const isbn13 = "9780306406157";
    const usdaClient = fakeUsdaClient();
    const upcLookupClient = fakeUpcLookupClient(async () =>
      upcResponse({
        upc: isbn13,
        name: "Theoretical Book",
        manufacturer: "Example Press",
        priceDollars: 24.5,
      }),
    );

    const result = await findOrCreateByCode(
      ctx.db,
      usdaClient,
      upcLookupClient,
      { kind: "isbn", value: isbn13.padStart(14, "0") },
      ctx.actor,
    );

    expect(result.created).toBe(true);
    expect(result.product).toMatchObject({
      name: "Theoretical Book",
      manufacturer: "Example Press",
      category: "books",
      primaryGtin: isbn13.padStart(14, "0"),
    });
    expect(usdaClient.findFood).not.toHaveBeenCalled();
    expect(upcLookupClient.lookup).toHaveBeenCalledWith(isbn13);
  });

  it("creates a named book placeholder when the provider has no match", async () => {
    const isbn13 = "9780261103573";
    const result = await findOrCreateByCode(
      ctx.db,
      fakeUsdaClient(),
      fakeUpcLookupClient(),
      { kind: "isbn", value: isbn13.padStart(14, "0") },
      ctx.actor,
    );

    expect(result.product).toMatchObject({
      name: `Book ISBN ${isbn13}`,
      manufacturer: UNSPECIFIED_MANUFACTURER,
      category: "books",
      primaryGtin: isbn13.padStart(14, "0"),
    });
  });

  it("resolves concurrent ISBN creation to one Product", async () => {
    const canonical = "09780132350884";
    const services = [fakeUsdaClient(), fakeUpcLookupClient()] as const;
    const [a, b] = await Promise.all([
      findOrCreateByCode(
        ctx.db,
        services[0],
        services[1],
        { kind: "isbn", value: canonical },
        ctx.actor,
      ),
      findOrCreateByCode(
        ctx.db,
        services[0],
        services[1],
        { kind: "isbn", value: canonical },
        ctx.actor,
      ),
    ]);

    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.product.id).toBe(b.product.id);
  });
});

describe("applyUpcDataWithSideEffects", () => {
  const ctx = withTestDb();

  it("backfills manufacturer and price from the UPC worker for a product missing them", async () => {
    const product = await quickCreateProduct(
      ctx.db,
      { name: "Blank Product", manufacturer: UNSPECIFIED_MANUFACTURER },
      ctx.actor,
    );
    const upc = "077777777777";
    const usdaClient = fakeUsdaClient();
    const upcLookupClient = fakeUpcLookupClient(async () =>
      upcResponse({ upc, manufacturer: "Acme Corp", priceDollars: 3.5 }),
    );

    const services = {
      db: ctx.db,
      product: createProductWriteActions(ctx.db, usdaClient),
      recipeCosting: new RecipeCostingService(ctx.db, usdaClient),
      locationValuation: new LocationValuationService(ctx.db),
      upcLookupClient,
    };

    const result = await applyUpcDataWithSideEffects(
      services,
      {
        id: parseEntityId(
          "product",
          (await resolveLiveShortcode(ctx.db, product.id, "product"))!,
        ),
        upc,
      },
      ctx.actor,
    );

    expect(result.manufacturer).toBe("Acme Corp");
    expect(result.price).toBe(3.5);
  });

  it("leaves an already-priced, already-branded product untouched", async () => {
    const product = await quickCreateProduct(
      ctx.db,
      { name: "Known Product", manufacturer: "Existing Brand", price: 9.99 },
      ctx.actor,
    );
    const upc = "088888888888";
    const usdaClient = fakeUsdaClient();
    const upcLookupClient = fakeUpcLookupClient(async () =>
      upcResponse({ upc, manufacturer: "Other Brand", priceDollars: 1.11 }),
    );

    const services = {
      db: ctx.db,
      product: createProductWriteActions(ctx.db, usdaClient),
      recipeCosting: new RecipeCostingService(ctx.db, usdaClient),
      locationValuation: new LocationValuationService(ctx.db),
      upcLookupClient,
    };

    const result = await applyUpcDataWithSideEffects(
      services,
      {
        id: parseEntityId(
          "product",
          (await resolveLiveShortcode(ctx.db, product.id, "product"))!,
        ),
        upc,
      },
      ctx.actor,
    );

    expect(result.manufacturer).toBe("Existing Brand");
    expect(result.price).toBe(9.99);
  });
});
