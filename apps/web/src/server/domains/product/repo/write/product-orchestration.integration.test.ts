import { ingredientShortcode } from "@cubby/schemas/identifiers";
import type { FoodSummary } from "@cubby/usda";
import { fromPartial } from "@total-typescript/shoehorn";
import { createRepoEntity } from "tooling/factories/repo";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { UPCLookupResponse } from "~/contracts/upc.contract";
import type { UpcLookupService, UpcLookupPort } from "~/server/clients/upc";
import type { UsdaFoodLookupPort } from "~/server/clients/usda";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { resolveProductCategory } from "~/server/domains/product-category/repo/product-category";
import { quickCreateProduct } from "~/server/domains/product/repo/crud";
import { findProductByGtin } from "~/server/domains/product/repo/lookup";
import {
  createProductWriteActions,
  createProductReadActions,
  readProductMutationFields,
} from "~/server/domains/product/repo/write/product-writes";
import { RecipeCostingService } from "~/server/domains/recipe/repo/recipe-costing";
import type { UsdaFoodBatchPort } from "~/server/domains/usda-food/repo/usda-helpers";
import {
  getVendorByID,
  findOrCreateVendor,
} from "~/server/domains/vendor/repo/vendor";
import { executeEntity } from "~/server/entity-kernel";
import { runDiagnostic } from "~/server/generic/problems/service/problem-diagnostics.service";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { requireActor } from "~/server/http/request-context";
import {
  createProductIdentityFixture,
  makeExpenseInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  applyUpcDataWithSideEffects,
  findOrCreateByCode,
  findOrCreateByUPC,
} from "./product-orchestration";

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
    brand_name: "Market Salt",
    branded_food_category: null,
    gtin_upc: "022222222220",
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

  // The create holds the uuid it inserted; resolving its fresh code back is a
  // wasted round trip on every scan of an unknown barcode.
  it("does not look up a created product's own code", async () => {
    const { result, statements } = await countTestDbQueries(() =>
      findOrCreateByUPC(
        ctx.db,
        usdaClient(),
        upcLookupClient(),
        "033333333330",
        undefined,
        ctx.actor,
      ),
    );
    expect(result.created).toBe(true);
    expect(
      statements.filter((statement) =>
        statement.startsWith(
          'select "id" from "Product" where ("Product"."shortcode" = $1',
        ),
      ),
    ).toEqual([]);
  });

  it("branch 1: returns the existing product without calling USDA or the UPC worker", async () => {
    const upc = "011111111110";
    const existing = await quickCreateProduct(
      ctx.db,
      { name: "Existing Widget", barcode: upc },
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
      sideEffects: {},
    });
  });

  it("branch 2: creates from a USDA match when no local product exists", async () => {
    const upc = "022222222220";
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
    expect(result.product.brandName).toBe("Market Salt");
    expect(result.product.primaryGtin).toBe(upc.padStart(14, "0"));
  });

  it("branch 3: falls back to the UPC worker when USDA has no match", async () => {
    const upc = "033333333330";
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
    expect(result.product.brandName).toBe("Widget Co");
    expect(result.product.price).toBe(4.99);
  });

  it("reports a failed cover-photo import as a warning without failing the create", async () => {
    const upc = "035555555552";
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
    const upc = "044444444440";
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
    expect(result.product.brandName).toBeNull();
    expect(result.product.brandId).toBeNull();
    expect(result.product.primaryGtin).toBe(upc.padStart(14, "0"));
  });

  it("resolves a concurrent create race to one winner without throwing", async () => {
    const upc = "066666666660";
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Distinct names force the loser through identifier conflict handling,
    // rather than accidentally recovering on Product's name index.
    const contender = findOrCreateByUPC(
      ctx.db,
      usdaClient(async () => {
        entered.resolve();
        await release.promise;
        return null;
      }),
      upcLookupClient(),
      upc,
      "Synthetic waiting product",
      ctx.actor,
    );
    await entered.promise;
    try {
      const winner = await findOrCreateByUPC(
        ctx.db,
        usdaClient(),
        upcLookupClient(),
        upc,
        "Synthetic winning product",
        ctx.actor,
      );
      release.resolve();
      const recovered = await contender;
      expect(winner.created).toBe(true);
      expect(recovered.created).toBe(false);
      expect(recovered.product.id).toBe(winner.product.id);
    } finally {
      release.resolve();
      await contender.catch(() => undefined);
    }
  });
});

describe("findOrCreateByCode", () => {
  const ctx = withTestDb();

  it("resolves concurrent ISBN creation to one Product", async () => {
    const canonical = "09780132350884";
    const services = [
      unexpectedUsdaClient(),
      upcLookupClient(async () =>
        upcResponse({ brand: "Synthetic Book Press" }),
      ),
    ] as const;
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
    expect(a.product.brandId).not.toBeNull();
    expect(a.product.brandName).toBe("Synthetic Book Press");
  });

  describe("ISBN title fallback", () => {
    const scanIsbn = (canonical: string, title: string) =>
      findOrCreateByCode(
        ctx.db,
        unexpectedUsdaClient(),
        upcLookupClient(async () =>
          upcResponse({ name: title, manufacturer: "Example Press" }),
        ),
        { kind: "isbn", value: canonical },
        ctx.actor,
      );
    const bookProduct = async (name: string, barcode?: string) =>
      quickCreateProduct(
        ctx.db,
        {
          name,
          categoryId: (await resolveProductCategory(ctx.db, null, "books"))!,
          ...(barcode && { barcode }),
        },
        ctx.actor,
      );

    it("attaches the ISBN to the single un-barcoded book whose title matches", async () => {
      const canonical = "09780132350884";
      const shelved = await bookProduct("The Example Handbook");

      const result = await scanIsbn(canonical, "the example  Handbook!");

      expect(result.created).toBe(false);
      expect(result.product.id).toBe(shelved.id);
      expect((await findProductByGtin(ctx.db, canonical))?.id).toBe(shelved.id);
    });

    it("creates a new Product when the title is ambiguous, barcoded, or not a book", async () => {
      await bookProduct("Twin Title Volume");
      await bookProduct("Twin Title Volume ");
      const twin = await scanIsbn("09780131103627", "Twin Title Volume");
      expect(twin.created).toBe(true);

      await bookProduct("Already Scanned Volume", "012345678905");
      const barcoded = await scanIsbn(
        "09780201633610",
        "Already Scanned Volume",
      );
      expect(barcoded.created).toBe(true);

      await quickCreateProduct(
        ctx.db,
        {
          name: "Hammer Guide",
          brandId: (
            await getVendorByID(
              ctx.db,
              await findOrCreateVendor(ctx.db, "Other Press"),
            )
          ).id,
        },
        ctx.actor,
      );
      const other = await scanIsbn("09780262033848", "Hammer Guide");
      expect(other.created).toBe(true);
    });
  });

  it("classifies a raw scan: a printed product label resolves by lookup", async () => {
    const upc = "044444444440";
    const existing = await quickCreateProduct(
      ctx.db,
      { name: "Labelled Widget", barcode: upc },
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
    const upc = "055555555550";
    const existing = await quickCreateProduct(
      ctx.db,
      { name: "Scanned Widget", barcode: upc },
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
      sideEffects: {},
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
    const upc = "076666666669";
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Unpriced widget", barcode: upc }),
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
    const upc = "077777777770";
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Ledger-priced widget", barcode: upc }),
      ctx.actor,
    );
    await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Ledger-priced widget purchase",
        cost: 12,
        productId: product.id,
        productQuantity: 2,
      }),
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
    const upc = "088888888880";
    let lookupCode: string | undefined;
    const context = {
      ...requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      upcLookupClient: fromPartial<UpcLookupService>(
        upcLookupClient(async (code) => {
          lookupCode = code;
          return upcResponse({ upc, imageUrl: "http://127.0.0.1/cover.jpg" });
        }),
      ),
    };

    const result = await executeEntity(context, {
      action: "create",
      entity: "product",
      data: makeProductInput({
        name: "Coverless widget",
        barcode: "0-88888\u0085-88888-0",
      }),
    });

    expect(lookupCode).toBe(upc);
    expect(result.sideEffects.warnings).toEqual([
      `Cover photo import for ${upc} failed: External URL points to a private or local host`,
    ]);
  });
});

describe("projected Product mutation reads", () => {
  const ctx = withTestDb();
  it("reads an id-only mutation result and its costing ingredient without looking up food", async () => {
    const ingredient = await findOrCreateIngredient(
      ctx.db,
      "Synthetic snapshot ingredient",
    );
    if (!ingredient) throw new Error("Missing synthetic ingredient");
    const ingredientId = ingredientShortcode.parse(ingredient.shortcode);
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic snapshot product",
        ingredientId,
        fdc_id: 123456,
      }),
      ctx.actor,
    );
    const id = await resolveOrThrow(ctx.db, "product", product.id);
    const client = unexpectedUsdaClient();
    const actions = createProductReadActions(
      ctx.db,
      client,
      (current, productId) =>
        readProductMutationFields(ctx.db, client, current, productId, ["id"]),
    );
    expect(await actions.getProductMutationSnapshot(id)).toEqual({
      id: product.id,
      ingredient: { id: ingredientId },
    });
    const updated = await actions.updateProduct(
      id,
      { notes: "Synthetic snapshot update" },
      ctx.actor,
    );
    expect(updated.output).toEqual({
      id: product.id,
      ingredient: { id: ingredientId },
    });
  });
});
