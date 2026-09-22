import { expenseCreateInput } from "@cubby/schemas/project";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { UPCLookupResponse } from "@cubby/upc-contract";
import type { FoodSummary } from "@cubby/usda-schemas";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type {
  UPCLookupClient,
  UpcLookupPort,
} from "~/server/clients/upc-lookup";
import type { UsdaFoodLookupPort } from "~/server/clients/usda";
import { executeEntity } from "~/server/entity-kernel";
import { createExpense } from "~/server/repo/expense";
import { quickCreateProduct } from "~/server/repo/product";
import {
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { requireActor } from "~/server/request-context";
import { runDiagnostic } from "~/server/services/problem-diagnostics.service";
import { createProductWriteActions } from "~/server/services/product.service";
import { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  applyUpcDataWithSideEffects,
  findOrCreateByCode,
  findOrCreateByUPC,
} from "./product-orchestration.service";
import type { UsdaFoodBatchPort } from "./usda-helpers";

// These deterministic adapters sit at genuine external seams. They contain no
// spies: tests assert only on orchestration outcomes, and an adapter that must
// not be reached throws if the production branch selection is wrong.
const usdaClient = (
  findFood: UsdaFoodLookupPort["findFood"] = async () => null,
): UsdaFoodLookupPort & UsdaFoodBatchPort => ({
  findFood,
  findFoodsBatch: async (lookups) => Promise.all(lookups.map(findFood)),
});

const upcLookupClient = (
  lookup: (upc: string) => Promise<UPCLookupResponse | null> = async () => null,
): UpcLookupPort => ({
  lookup,
  lookupBatch: async (upcs: string[]) => {
    const entries = await Promise.all(
      upcs.map(async (upc) => [upc, await lookup(upc)] as const),
    );
    return new Map(
      entries.filter(
        (entry): entry is readonly [string, UPCLookupResponse] =>
          entry[1] != null,
      ),
    );
  },
});

const unexpectedUsdaClient = () =>
  usdaClient(async () => {
    throw new Error("USDA lookup was not expected");
  });

const unexpectedUpcLookupClient = () =>
  upcLookupClient(async () => {
    throw new Error("UPC lookup was not expected");
  });

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
    const result = await findOrCreateByUPC(
      ctx.db,
      unexpectedUsdaClient(),
      unexpectedUpcLookupClient(),
      upc,
      undefined,
      ctx.actor,
    );

    expect(result).toEqual({
      product: existing,
      created: false,
      sideEffects: { backgroundBatches: [] },
    });
  });

  it("branch 2: creates from a USDA match when no local product exists", async () => {
    const upc = "022222222222";
    const food = usdaFood({ fdc_id: 222222 });
    const result = await findOrCreateByUPC(
      ctx.db,
      usdaClient(async () => food),
      unexpectedUpcLookupClient(),
      upc,
      undefined,
      ctx.actor,
    );

    expect(result.created).toBe(true);
    expect(result.product.name).toBe("Store Brand Salt");
    expect(result.product.manufacturer).toBe("Acme");
    expect(result.product.primaryGtin).toBe(upc.padStart(14, "0"));
  });

  it("branch 3: falls back to the UPC worker when USDA has no match", async () => {
    const upc = "033333333333";
    const result = await findOrCreateByUPC(
      ctx.db,
      usdaClient(),
      upcLookupClient(async () =>
        upcResponse({
          upc,
          name: "Widget Deluxe",
          manufacturer: "Widget Co",
          priceDollars: 4.99,
        }),
      ),
      upc,
      undefined,
      ctx.actor,
    );

    expect(result.created).toBe(true);
    expect(result.product.name).toBe("Widget Deluxe");
    expect(result.product.manufacturer).toBe("Widget Co");
    expect(result.product.price).toBe(4.99);
  });

  it("reports a failed cover-photo import as a warning without failing the create", async () => {
    const upc = "035555555555";
    const result = await findOrCreateByUPC(
      ctx.db,
      usdaClient(),
      upcLookupClient(async () =>
        upcResponse({ upc, imageUrl: "http://127.0.0.1/cover.jpg" }),
      ),
      upc,
      undefined,
      ctx.actor,
    );

    expect(result.created).toBe(true);
    expect(result.product.name).toBe("Widget Deluxe");
    expect(result.sideEffects.warnings).toEqual([
      `Cover photo import for ${upc} failed: External URL points to a private or local host`,
    ]);
  });

  it("branch 4: creates a default product when nothing is found anywhere", async () => {
    const upc = "044444444444";
    const result = await findOrCreateByUPC(
      ctx.db,
      usdaClient(),
      upcLookupClient(),
      upc,
      "Fallback Name",
      ctx.actor,
    );

    expect(result.created).toBe(true);
    expect(result.product.name).toBe("Fallback Name");
    expect(result.product.manufacturer).toBe(UNSPECIFIED_MANUFACTURER);
    expect(result.product.primaryGtin).toBe(upc.padStart(14, "0"));
  });

  it("resolves a concurrent create race to one winner without throwing", async () => {
    const upc = "066666666666";
    // Two truly-concurrent callers for a brand-new UPC: both pass the initial
    // findProductByUPC check, then race on the create — runWithConflictRecovery
    // must convert the loser's unique-violation into a re-SELECT of the
    // winner instead of surfacing a 500.
    const [a, b] = await Promise.all([
      findOrCreateByUPC(
        ctx.db,
        usdaClient(),
        upcLookupClient(),
        upc,
        "Race Product",
        ctx.actor,
      ),
      findOrCreateByUPC(
        ctx.db,
        usdaClient(),
        upcLookupClient(),
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

  it("resolves concurrent ISBN creation to one Product", async () => {
    const canonical = "09780132350884";
    const services = [unexpectedUsdaClient(), upcLookupClient()] as const;
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

  it("classifies a raw scan: a printed product label resolves by lookup", async () => {
    const upc = "044444444444";
    const existing = await quickCreateProduct(
      ctx.db,
      { name: "Labelled Widget", upc },
      ctx.actor,
    );
    const result = await findOrCreateByCode(
      ctx.db,
      unexpectedUsdaClient(),
      unexpectedUpcLookupClient(),
      { kind: "scan", value: `https://cubby.example.com/${existing.id}` },
      ctx.actor,
    );
    // A label resolves through the detail read, so compare identity, not shape.
    expect(result.created).toBe(false);
    expect(result.product.id).toBe(existing.id);
  });

  it("classifies a raw scan: a barcode takes the UPC path", async () => {
    const upc = "055555555555";
    const existing = await quickCreateProduct(
      ctx.db,
      { name: "Scanned Widget", upc },
      ctx.actor,
    );
    const result = await findOrCreateByCode(
      ctx.db,
      unexpectedUsdaClient(),
      unexpectedUpcLookupClient(),
      { kind: "scan", value: ` ${upc} ` },
      ctx.actor,
    );
    expect(result).toEqual({
      product: existing,
      created: false,
      sideEffects: { backgroundBatches: [] },
    });
  });

  it("refuses a raw scan that names nothing stockable with the scanner's copy", async () => {
    await expect(
      findOrCreateByCode(
        ctx.db,
        unexpectedUsdaClient(),
        unexpectedUpcLookupClient(),
        { kind: "scan", value: "RCP-4K7M" },
        ctx.actor,
      ),
    ).rejects.toMatchObject({
      message: "That's a recipe label — nothing that sits on a shelf.",
      reason: "SCAN_CODE_UNRECOGNIZED",
    });
  });
});

describe("applyUpcDataWithSideEffects", () => {
  const ctx = withTestDb();

  it("uses the UPC price only when the Product has no purchase history", async () => {
    const upc = "076666666666";
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Unpriced widget", upc }),
      ctx.actor,
    );
    const result = await applyUpcDataWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, usdaClient()),
        recipeCosting: new RecipeCostingService(ctx.db, usdaClient()),
        upcLookupClient: upcLookupClient(async () =>
          upcResponse({ upc, priceDollars: 9.99 }),
        ),
      },
      { id: product.entityId, upc },
      ctx.actor,
    );

    expect(result.pricing).toMatchObject({
      derivedPrice: null,
      effectivePrice: 9.99,
      source: "explicit",
    });
  });

  it("keeps an Expense-derived price and omits the corresponding UPC proposal", async () => {
    const upc = "077777777777";
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Ledger-priced widget", upc }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Ledger-priced widget purchase",
          cost: 12,
          productId: product.id,
          productQuantity: 2,
        }),
      ),
      ctx.actor,
    );
    const lookup = upcLookupClient(async () =>
      upcResponse({ upc, priceDollars: 9.99 }),
    );
    const result = await applyUpcDataWithSideEffects(
      {
        db: ctx.db,
        product: createProductWriteActions(ctx.db, usdaClient()),
        recipeCosting: new RecipeCostingService(ctx.db, usdaClient()),
        upcLookupClient: lookup,
      },
      { id: product.entityId, upc },
      ctx.actor,
    );

    expect(result.price).toBeNull();
    expect(result.pricing).toMatchObject({
      derivedPrice: 6,
      effectivePrice: 6,
      source: "derived",
    });

    const diagnostic = await runDiagnostic(
      ctx.db,
      "products-with-better-upc-data",
      { upcLookupClient: unexpectedUpcLookupClient() },
      { kind: "sample", limit: 12 },
    );
    expect(diagnostic.items).toEqual([]);
    expect(diagnostic.count).toBe(0);
  });
});

describe("product create cover-photo warnings", () => {
  const ctx = withTestDb();

  it("carries a failed cover import on the entity create result", async () => {
    const upc = "088888888888";
    const context = {
      ...requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      upcLookupClient: fromPartial<UPCLookupClient>(
        upcLookupClient(async () =>
          upcResponse({ upc, imageUrl: "http://127.0.0.1/cover.jpg" }),
        ),
      ),
    };

    const result = await executeEntity(context, {
      action: "create",
      entity: "product",
      data: makeProductInput({ name: "Coverless widget", upc }),
    });

    expect(result.sideEffects.warnings).toEqual([
      `Cover photo import for ${upc.padStart(14, "0")} failed: External URL points to a private or local host`,
    ]);
  });
});
