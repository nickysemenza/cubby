import type { ProductId } from "@cubby/schemas/identifiers";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { UPCLookupResponse } from "@cubby/upc-lookup/schemas";
import type { FoodSummary } from "@cubby/usda-schemas";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import { image, product, productImage } from "~/server/db/schema";
import { getDb } from "./database-helpers";
import { createIngredient, getIngredientByName } from "./ingredient";
import { findAllProblems, reparseStaleIngredientParses } from "./problems";
import { createProduct } from "./product";
import { createRecipe } from "./recipe";
import {
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";

// Repo-layer tests for the WASM-driven, highest-logic problem scans. The private
// find* helpers are exercised through the public findAllProblems aggregator;
// reparseStaleIngredientParses is called directly.

// Build a full UPCLookupResponse from a partial — only the fields a scan reads
// (manufacturer/brand/priceDollars/imageUrl) usually matter per test.
const upcResponse = (
  upc: string,
  overrides: Partial<UPCLookupResponse> = {},
): UPCLookupResponse => ({
  upc,
  name: "Looked Up Product",
  manufacturer: null,
  brand: null,
  category: null,
  description: null,
  priceDollars: null,
  imageUrl: null,
  source: "upcitemdb" as UPCLookupResponse["source"],
  cached: false,
  ...overrides,
});

// A fake UPC lookup client: canned responses keyed by UPC, plus a record of which
// UPCs were actually looked up (so tests can assert the no-network pre-filter).
// The scan calls `lookupBatch` (one bulk request), so `calls` records every UPC
// passed to it — fully-populated/misc products are pre-filtered out beforehand.
const fakeUpcClient = (
  byUpc: Record<string, UPCLookupResponse | null> = {},
) => {
  const calls: string[] = [];
  const client = {
    lookupBatch: async (upcs: string[]) => {
      calls.push(...upcs);
      const result = new Map<string, UPCLookupResponse>();
      for (const upc of upcs) {
        const hit = byUpc[upc];
        if (hit) result.set(upc, hit);
      }
      return result;
    },
  } as unknown as UPCLookupClient;
  return { client, calls };
};

// USDA client stub. `findFoodsBatch` is the only method batchEnrichWithFood
// touches; it returns the supplied foods positionally (one per valid lookup;
// null = no link / no match). The default empty list means "no USDA data".
const fakeUsdaClient = (foods: (FoodSummary | null)[] = []) =>
  ({
    findFoodsBatch: async (lookups: unknown[]) =>
      lookups.map((_, i) => foods[i] ?? null),
  }) as unknown as USDAClient;

describe("problems repo", () => {
  const ctx = withTestDb();

  // A recipe whose single ingredient row stores `amounts`/`rawLine`; a mismatch
  // between rawLine's fresh parse and the stored amounts is parse drift.
  const recipeWithRow = (
    name: string,
    ingredientId: string,
    opts: { amounts: { value: number; unit: string }[]; rawLine: string },
  ) =>
    createRecipe(
      ctx.db,
      makeRecipeInput({
        name,
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(ingredientId, opts)],
          },
        ],
      }),
      ctx.actor,
    );

  describe("findStaleIngredientParses", () => {
    it("flags a row whose stored parse drifted and leaves a matching row alone", async () => {
      const flour = await createIngredient(
        ctx.db,
        { name: "flour", aliases: [] },
        ctx.actor,
      );

      // Drift: rawLine parses to 2 cup, but 99 cup is stored.
      const drifted = await recipeWithRow("Drifted", flour.id, {
        amounts: [{ value: 99, unit: "cup" }],
        rawLine: "2 cups flour",
      });
      // No drift: stored amounts match the fresh parse.
      const clean = await recipeWithRow("Clean", flour.id, {
        amounts: [{ value: 2, unit: "cup" }],
        rawLine: "2 cups flour",
      });

      const { staleIngredientParses } = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      const driftedEntry = staleIngredientParses.find(
        (s) => s.recipeId === drifted.id,
      );
      expect(driftedEntry).toBeDefined();
      expect(driftedEntry?.amountDrift).toBe(true);
      expect(driftedEntry?.nameDrift).toBe(false);
      expect(staleIngredientParses.some((s) => s.recipeId === clean.id)).toBe(
        false,
      );
    });
  });

  describe("reparseStaleIngredientParses", () => {
    it("re-parses drifted amounts, marks the recipe affected, and is idempotent", async () => {
      const flour = await createIngredient(
        ctx.db,
        { name: "flour", aliases: [] },
        ctx.actor,
      );
      const recipe = await recipeWithRow("Reparse", flour.id, {
        amounts: [{ value: 99, unit: "cup" }],
        rawLine: "2 cups flour",
      });

      const result = await reparseStaleIngredientParses(ctx.db);
      expect(result.updated).toBeGreaterThanOrEqual(1);
      expect(result.recipesAffected).toContain(recipe.id);

      // The drift is gone, and a second run finds nothing.
      const { staleIngredientParses } = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(staleIngredientParses.some((s) => s.recipeId === recipe.id)).toBe(
        false,
      );
      expect((await reparseStaleIngredientParses(ctx.db)).updated).toBe(0);
    });

    it("find-or-creates the ingredient when the parsed name drifted", async () => {
      // Stored name "flour" but the raw line parses to "sugar" → name drift.
      const flour = await createIngredient(
        ctx.db,
        { name: "flour", aliases: [] },
        ctx.actor,
      );
      await recipeWithRow("NameDrift", flour.id, {
        amounts: [{ value: 2, unit: "cup" }],
        rawLine: "2 cups sugar",
      });

      await reparseStaleIngredientParses(ctx.db);
      // The re-parse find-or-created the drifted-to ingredient.
      expect(await getIngredientByName(ctx.db, "sugar")).not.toBeNull();
    });
  });

  describe("findProductsWithIslandedMappings", () => {
    it("flags a product whose mappings form 2+ islands but not a connected one", async () => {
      // widget↔gadget are custom units unreachable from the standard unit graph,
      // so they island off from cup↔g.
      const islanded = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Islanded Product",
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 120, unit: "g" },
              source: null,
            },
            {
              a: { value: 1, unit: "widget" },
              b: { value: 3, unit: "gadget" },
              source: null,
            },
          ],
        }),
        ctx.actor,
      );
      // cup↔g and tsp↔ml all sit in the one connected standard graph.
      const connected = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Connected Product",
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 120, unit: "g" },
              source: null,
            },
            {
              a: { value: 1, unit: "tsp" },
              b: { value: 5, unit: "ml" },
              source: null,
            },
          ],
        }),
        ctx.actor,
      );

      const { productsWithIslandedMappings } = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      const flagged = productsWithIslandedMappings.find(
        (p) => p.id === islanded.id,
      );
      expect(flagged).toBeDefined();
      expect(flagged!.islandCount).toBeGreaterThanOrEqual(2);
      expect(
        productsWithIslandedMappings.some((p) => p.id === connected.id),
      ).toBe(false);
    });

    it("does not flag a product whose USDA portion bridges the stored islands", async () => {
      // Mirrors "light brown sugar": its two STORED mappings island into
      // {cup packed, tsp, ml} (volume) and {g, cent} (weight/money), with no
      // stored edge between them. But its USDA link supplies a portion
      // (1 cup packed = 220 g) that bridges the two — so it's fully convertible
      // and must NOT be flagged. The detector now runs on effective mappings.
      const storedIslands = [
        // 1 cup packed = 1 cup → cup packed joins the volume cluster.
        {
          a: { value: 1, unit: "cup packed" },
          b: { value: 1, unit: "cup" },
          source: null,
        },
        // 2 lb = $5 → lb normalizes to g; the {g, cent} island.
        {
          a: { value: 2, unit: "lb" },
          b: { value: 5, unit: "dollar" },
          source: null,
        },
      ];
      // A USDA "Sugars, brown" food whose portion bridges cup packed ↔ g.
      const sugarFood: FoodSummary = {
        fdc_id: 168833,
        brandedFoodInfo: null,
        foodInfo: { data_type: "sr_legacy_food", description: "Sugars, brown" },
        legacyFoodInfo: { ndb_number: 19334 },
        nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
        portionInfoRaw: [
          { amount: 1, modifier: "cup packed", gram_weight: 220 },
        ],
      };

      const product = await createProduct(
        ctx.db,
        makeProductInput({
          name: "USDA-bridged sugar",
          // The USDA link is what pulls in the bridging portion below; without an
          // fdc_id no lookup fires and the stored mappings island on their own.
          fdc_id: sugarFood.fdc_id,
          unitMappings: storedIslands,
        }),
        ctx.actor,
      );

      // Control: WITHOUT the USDA food, stored mappings alone island → flagged.
      const withoutFood = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient([null]),
      );
      expect(
        withoutFood.productsWithIslandedMappings.some(
          (p) => p.id === product.id,
        ),
      ).toBe(true);

      // With the bridging USDA portion, the product is one component → not flagged.
      const withFood = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient([sugarFood]),
      );
      expect(
        withFood.productsWithIslandedMappings.some((p) => p.id === product.id),
      ).toBe(false);
    });
  });

  describe("findProductsWithBetterUpcData", () => {
    // Valid UPC-A codes (12 digits) so the products clear the candidate query.
    const UPC_MANU = "012345678905";
    const UPC_PRICE = "036000291452";
    const UPC_IMAGE = "078000053258";
    const UPC_FULL = "022000004444";
    const UPC_MISC = "044000031091";

    const attachImage = async (productId: ProductId) => {
      const [img] = await getDb(ctx.db)
        .insert(image)
        .values({
          url: "https://example.com/i.jpg",
          key: `key-${productId}`,
          filename: "i.jpg",
          size: 1,
          contentType: "image/jpeg",
        })
        .returning();
      await getDb(ctx.db)
        .insert(productImage)
        .values({ productId, imageId: img!.id });
    };

    it("flags each fillable gap and skips fully-populated products without a lookup", async () => {
      // (a) Unspecified manufacturer, but priced + imaged → only the manufacturer gap.
      const noManu = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Manufacturer", upc: UPC_MANU }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ manufacturer: UNSPECIFIED_MANUFACTURER, price: 5 })
        .where(eq(product.id, noManu.id));
      await attachImage(noManu.id);

      // (b) Has manufacturer + image, but no price → only the price gap.
      const noPrice = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Price", upc: UPC_PRICE }),
        ctx.actor,
      );
      await attachImage(noPrice.id);

      // (c) Has manufacturer + price, but no image → only the image gap.
      const noImage = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Image", upc: UPC_IMAGE }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 9 })
        .where(eq(product.id, noImage.id));

      // (d) Fully populated → not a candidate, must never be looked up.
      const full = await createProduct(
        ctx.db,
        makeProductInput({ name: "Full Product", upc: UPC_FULL }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 3 })
        .where(eq(product.id, full.id));
      await attachImage(full.id);

      // (e) Misc product with a manufacturer gap → excluded regardless.
      const misc = await createProduct(
        ctx.db,
        makeProductInput({ name: "misc: Loose Screw", upc: UPC_MISC }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ manufacturer: UNSPECIFIED_MANUFACTURER, price: 1 })
        .where(eq(product.id, misc.id));
      await attachImage(misc.id);

      const { client, calls } = fakeUpcClient({
        [UPC_MANU]: upcResponse(UPC_MANU, { brand: "Acme" }),
        [UPC_PRICE]: upcResponse(UPC_PRICE, { priceDollars: 4.5 }),
        [UPC_IMAGE]: upcResponse(UPC_IMAGE, {
          imageUrl: "https://example.com/p.jpg",
        }),
        // A response for the full product would still be irrelevant — it must not be fetched.
        [UPC_FULL]: upcResponse(UPC_FULL, { brand: "Acme", priceDollars: 1 }),
      });

      const { productsWithBetterUpcData } = await findAllProblems(
        ctx.db,
        client,
        fakeUsdaClient(),
      );

      const byId = new Map(productsWithBetterUpcData.map((p) => [p.id, p]));

      expect(byId.get(noManu.id)?.gaps).toEqual({
        manufacturer: true,
        price: false,
        image: false,
      });
      expect(byId.get(noPrice.id)?.gaps).toEqual({
        manufacturer: false,
        price: true,
        image: false,
      });
      expect(byId.get(noImage.id)?.gaps).toEqual({
        manufacturer: false,
        price: false,
        image: true,
      });

      // Fully-populated and misc products are neither flagged nor looked up.
      expect(byId.has(full.id)).toBe(false);
      expect(byId.has(misc.id)).toBe(false);
      expect(calls).not.toContain(UPC_FULL);
      expect(calls).not.toContain(UPC_MISC);
    });

    it("does not flag a gap the lookup itself can't fill", async () => {
      // Missing price, but the lookup has no price either → nothing to re-import.
      const noPrice = await createProduct(
        ctx.db,
        makeProductInput({ name: "Still No Price", upc: UPC_PRICE }),
        ctx.actor,
      );
      await attachImage(noPrice.id);

      const { client } = fakeUpcClient({
        [UPC_PRICE]: upcResponse(UPC_PRICE), // all-null payload
      });

      const { productsWithBetterUpcData } = await findAllProblems(
        ctx.db,
        client,
        fakeUsdaClient(),
      );
      expect(productsWithBetterUpcData.some((p) => p.id === noPrice.id)).toBe(
        false,
      );
    });
  });
});
