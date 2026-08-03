import type {
  LocationId,
  ProductId,
  ProjectShortcode,
  PurchaseShortcode,
} from "@cubby/schemas/identifiers";
import { unsafePurchaseId } from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import {
  countProblems,
  PROBLEM_CLASS,
  sumProblemSections,
} from "@cubby/schemas/problems";
import {
  type ExpenseCreateInput,
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { purchaseUpdateInput } from "@cubby/schemas/purchase";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import type { UPCLookupResponse } from "@cubby/upc-contract";
import type { FoodSummary } from "@cubby/usda-schemas";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { householdDaysAgo, householdDaysFromNow } from "~/lib/household-date";
import { VENDOR_LOGO_BY_SHORTCODE } from "~/lib/vendor-logos.generated";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import {
  financialTransaction,
  image,
  inventoryEntry,
  location as locationTable,
  product,
  productImage,
  vendor as vendorTable,
} from "~/server/db/schema";
import {
  findAllProblems,
  findFastProblems,
  findTrackerProblems,
  reparseStaleIngredientParses,
} from "../services/problems.service";
import { getDb } from "./database-helpers";
import { createExpense, deleteExpenses } from "./expense";
import { createIngredient, getIngredientByName } from "./ingredient";
import { deleteInventoryEntries } from "./inventory";
import { ensureGlobalUnknownLocation } from "./location";
import { findCoverageTotals, findStaleIngredientParses } from "./problems";
import { deleteProducts, updateProduct } from "./product";
import { createProject, deleteProjects } from "./project";
import { updatePurchase } from "./purchase";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  createRecipeFixture as createRecipe,
  ingredientRef,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";
import { resolveLiveShortcode } from "./shortcode-resolver";
import { insertWithShortcode } from "./shortcode-utils";
import { createTask, deleteTasks } from "./task";
import { findOrCreateVendor, getVendorByID, mergeVendors } from "./vendor";

/**
 * The ledger repos hand back `{ output, entityId }` — the uuid is for audit and
 * side-effect bookkeeping. These tests assert on the public shape.
 */
const unwrap = async <T>(p: Promise<{ output: T }>): Promise<T> =>
  (await p).output;

// Repo-layer tests for the WASM-driven, highest-logic problem scans. The
// coverage/UPC find* helpers are exercised through the public findAllProblems
// aggregator; the stale-parse detector (now a Settings → Maintenance action, off
// the aggregator) and reparseStaleIngredientParses are called directly.

// reparseStaleIngredientParses streams `{done,total}` progress and returns its
// summary; drain to the return value for assertions.
const drainGen = async <R>(gen: AsyncGenerator<unknown, R>): Promise<R> => {
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
};

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

      const staleIngredientParses = await findStaleIngredientParses(ctx.db);
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

      const result = await drainGen(reparseStaleIngredientParses(ctx.db));
      expect(result.updated).toBeGreaterThanOrEqual(1);
      expect(result.recipesAffected).toContain(recipe.entityId);

      // The drift is gone, and a second run finds nothing.
      const staleIngredientParses = await findStaleIngredientParses(ctx.db);
      expect(staleIngredientParses.some((s) => s.recipeId === recipe.id)).toBe(
        false,
      );
      expect(
        (await drainGen(reparseStaleIngredientParses(ctx.db))).updated,
      ).toBe(0);
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

      await drainGen(reparseStaleIngredientParses(ctx.db));
      // The re-parse find-or-created the drifted-to ingredient.
      expect(await getIngredientByName(ctx.db, "sugar")).not.toBeNull();
    });
  });

  describe("findOrphanedProducts", () => {
    it("flags a product whose only inventory entry was soft-deleted", async () => {
      // The regression this guards: the EXISTS subquery used to omit
      // notDeleted(inventoryEntry), so a soft-deleted row still counted as
      // "has inventory" and the product stayed invisible. Emptying a shelf
      // soft-deletes rather than hard-deletes, so that was the common case —
      // it hid 18 of 20 genuinely-uninventoried products in production.
      const loc = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Orphan shelf" }),
        ctx.actor,
      );
      const emptied = await createProduct(
        ctx.db,
        makeProductInput({ name: "Emptied Product" }),
        ctx.actor,
      );
      const stocked = await createProduct(
        ctx.db,
        makeProductInput({ name: "Stocked Product" }),
        ctx.actor,
      );
      const entry = await createInventoryEntry(
        ctx.db,
        {
          productId: emptied.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: stocked.id,
          locationId: loc.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      // Live inventory on both — neither is orphaned yet.
      const before = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(before.orphanedProducts.some((p) => p.id === emptied.id)).toBe(
        false,
      );

      await deleteInventoryEntries(ctx.db, [entry.entityId], ctx.actor);

      const after = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(after.orphanedProducts.some((p) => p.id === emptied.id)).toBe(
        true,
      );
      // The still-stocked product must not be swept up.
      expect(after.orphanedProducts.some((p) => p.id === stocked.id)).toBe(
        false,
      );
    });

    it("does not flag a product with no inventory but a live expense, and flags it once the expense is soft-deleted", async () => {
      // The regression this guards: omitting the `expense` subquery made 32 of
      // 40 flagged "orphans" false positives — a tool bought and logged in the
      // ledger, then never inventoried, looks exactly like one that was never
      // real. Inventory and expense are Product's two acquisition edges, so
      // both must be checked before calling something orphaned.
      const bought = await createProduct(
        ctx.db,
        makeProductInput({ name: "Bought Not Yet Stocked" }),
        ctx.actor,
      );
      const { output: expense } = await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "tools",
          name: "orphan-guard expense",
          productId: bought.id,
        }),
        ctx.actor,
      );

      // A live expense disqualifies it — not orphaned yet.
      const before = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(before.orphanedProducts.some((p) => p.id === bought.id)).toBe(
        false,
      );

      await deleteExpenses(ctx.db, [expense.id], ctx.actor);

      // With the expense gone (and still no inventory), it's orphaned.
      const after = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(after.orphanedProducts.some((p) => p.id === bought.id)).toBe(true);
    });

    it("does not flag a product used as a live task subject, and flags it once the task is deleted", async () => {
      const maintained = await createProduct(
        ctx.db,
        makeProductInput({ name: "Maintained Furnace" }),
        ctx.actor,
      );
      const { output: task } = await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: "Replace furnace filter",
          trade: "mechanical",
          subjectProductId: maintained.id,
        }),
        ctx.actor,
      );

      const before = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(before.orphanedProducts.some((p) => p.id === maintained.id)).toBe(
        false,
      );

      await deleteTasks(ctx.db, [task.id], ctx.actor);

      const after = await findAllProblems(
        ctx.db,
        fakeUpcClient().client,
        fakeUsdaClient(),
      );
      expect(after.orphanedProducts.some((p) => p.id === maintained.id)).toBe(
        true,
      );
    });
  });

  describe("findProductsMissingPrice", () => {
    it("flags stocked unpriced products, partitions misc buckets, and ignores priced or unstocked ones", async () => {
      const loc = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Valuation shelf" }),
        ctx.actor,
      );
      const unpriced = await createProduct(
        ctx.db,
        makeProductInput({ name: "Unpriced Stocked Tool", price: null }),
        ctx.actor,
      );
      const priced = await createProduct(
        ctx.db,
        makeProductInput({ name: "Priced Stocked Tool", price: 42 }),
        ctx.actor,
      );
      // A `misc:` pile is a heterogeneous bucket with no meaningful unit price,
      // so it belongs in the informational section, not the actionable one.
      const bucket = await createProduct(
        ctx.db,
        makeProductInput({ name: "misc: assorted clamps", price: null }),
        ctx.actor,
      );
      // Unpriced but not stocked — contributes to no rollup, so not a problem
      // here (findOrphanedProducts already covers it).
      const unstocked = await createProduct(
        ctx.db,
        makeProductInput({ name: "Unpriced Unstocked Tool", price: null }),
        ctx.actor,
      );

      const unpricedEntry = await createInventoryEntry(
        ctx.db,
        {
          productId: unpriced.id,
          locationId: loc.id,
          amount: { value: 3, unit: "each" },
        },
        ctx.actor,
      );
      for (const productId of [priced.id, bucket.id]) {
        await createInventoryEntry(
          ctx.db,
          { productId, locationId: loc.id, amount: { value: 1, unit: "each" } },
          ctx.actor,
        );
      }

      const found = await findFastProblems(ctx.db);

      const flagged = found.productsMissingPrice.find(
        (p) => p.id === unpriced.id,
      );
      expect(flagged).toBeDefined();
      // Quantity is summed across live entries so the card can say how much
      // value is going unrecorded.
      expect(flagged?.inventoryQuantity).toBe(3);
      expect(flagged?.locations.map((l) => l.id)).toEqual([loc.id]);

      // A price, no inventory, or misc-bucket status each keep it out.
      for (const id of [priced.id, bucket.id, unstocked.id]) {
        expect(found.productsMissingPrice.some((p) => p.id === id)).toBe(false);
      }
      expect(found.unvaluedBucketProducts.some((p) => p.id === bucket.id)).toBe(
        true,
      );
      expect(
        found.unvaluedBucketProducts.some((p) => p.id === unstocked.id),
      ).toBe(false);

      // Soft-deleting the only entry un-stocks it, so it drops out of both.
      await deleteInventoryEntries(ctx.db, [unpricedEntry.entityId], ctx.actor);
      const after = await findFastProblems(ctx.db);
      expect(after.productsMissingPrice.some((p) => p.id === unpriced.id)).toBe(
        false,
      );
      expect(
        after.unvaluedBucketProducts.some((p) => p.id === unpriced.id),
      ).toBe(false);
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

    const attachPdf = async (productId: ProductId) => {
      const [img] = await getDb(ctx.db)
        .insert(image)
        .values({
          url: "https://example.com/manual.pdf",
          key: `pdf-key-${productId}`,
          filename: "manual.pdf",
          size: 1,
          contentType: PDF_CONTENT_TYPE,
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
        .where(eq(product.id, noManu.entityId));
      await attachImage(noManu.entityId);

      // (b) Has manufacturer + image, but no price → only the price gap.
      const noPrice = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Price", upc: UPC_PRICE }),
        ctx.actor,
      );
      await attachImage(noPrice.entityId);

      // (c) Has manufacturer + price, but no image → only the image gap.
      const noImage = await createProduct(
        ctx.db,
        makeProductInput({ name: "No Image", upc: UPC_IMAGE }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 9 })
        .where(eq(product.id, noImage.entityId));

      // (d) Fully populated → not a candidate, must never be looked up.
      const full = await createProduct(
        ctx.db,
        makeProductInput({ name: "Full Product", upc: UPC_FULL }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 3 })
        .where(eq(product.id, full.entityId));
      await attachImage(full.entityId);

      // (e) Misc product with a manufacturer gap → excluded regardless.
      const misc = await createProduct(
        ctx.db,
        makeProductInput({ name: "misc: Loose Screw", upc: UPC_MISC }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ manufacturer: UNSPECIFIED_MANUFACTURER, price: 1 })
        .where(eq(product.id, misc.entityId));
      await attachImage(misc.entityId);

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

      // `proposed` carries the value each gap would be filled with (null = no
      // change). An absolute lookup image URL is returned unchanged.
      expect(byId.get(noManu.id)?.proposed).toEqual({
        manufacturer: "Acme",
        price: null,
        imageUrl: null,
      });
      expect(byId.get(noPrice.id)?.proposed).toEqual({
        manufacturer: null,
        price: 4.5,
        imageUrl: null,
      });
      expect(byId.get(noImage.id)?.proposed).toEqual({
        manufacturer: null,
        price: null,
        imageUrl: "https://example.com/p.jpg",
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
      await attachImage(noPrice.entityId);

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

    it("treats a PDF-only attachment as no real image, so it still surfaces as an image-gap candidate", async () => {
      // Regression: `hasImage` used to read true off ProductImage alone, so a
      // product whose only attachment was a PDF (an owner's manual, a spec
      // sheet) looked fully imaged and silently dropped out of the UPC-lookup
      // candidate list — it never got the chance to have a real photo filled
      // in. `hasImage` now inner-joins Image and excludes PDF_CONTENT_TYPE,
      // matching `productIdsWithImages` in product/crud.ts.
      const pdfOnly = await createProduct(
        ctx.db,
        makeProductInput({ name: "Manual Only Product", upc: UPC_IMAGE }),
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(product)
        .set({ price: 9 })
        .where(eq(product.id, pdfOnly.entityId));
      await attachPdf(pdfOnly.entityId);

      const { client } = fakeUpcClient({
        [UPC_IMAGE]: upcResponse(UPC_IMAGE, {
          imageUrl: "https://example.com/real-photo.jpg",
        }),
      });

      const { productsWithBetterUpcData } = await findAllProblems(
        ctx.db,
        client,
        fakeUsdaClient(),
      );

      const flagged = productsWithBetterUpcData.find(
        (p) => p.id === pdfOnly.id,
      );
      expect(flagged).toBeDefined();
      expect(flagged?.proposed).toEqual({
        manufacturer: null,
        price: null,
        imageUrl: "https://example.com/real-photo.jpg",
      });
    });
  });
});

// The household-tracker slice of the Problems payload. Detection itself lives in
// repo/project/attention.ts (covered there); this asserts the service-layer
// split — that the flat attention list lands in the right per-rule slices, and
// that a removed project's rows don't leak into the always-on badge count.
describe("problems service — tracker slice", () => {
  const ctx = withTestDb();

  it("surfaces an overdue task and a past-due planned expense in their slices", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "tracker slice project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const { output: overdue } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker overdue task",
        projectId: project.id,
        dueDate: householdDaysAgo(3),
      }),
      ctx.actor,
    );
    // Control: a task due in the future is not overdue.
    const { output: upcoming } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker upcoming task",
        projectId: project.id,
        dueDate: householdDaysFromNow(3),
      }),
      ctx.actor,
    );
    const { output: pastDuePlanned } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "tracker past-due planned expense",
        projectId: project.id,
        cost: 250,
        future: true,
        date: householdDaysAgo(5),
      }),
      ctx.actor,
    );

    const tracker = await findTrackerProblems(ctx.db);

    expect(tracker.overdueTasks.map((i) => i.entityId)).toContain(overdue.id);
    expect(tracker.overdueTasks.map((i) => i.entityId)).not.toContain(
      upcoming.id,
    );
    expect(tracker.pastDuePlannedExpenses.map((i) => i.entityId)).toContain(
      pastDuePlanned.id,
    );
    // Rows carry the rule type + a route the Problems card can link to.
    expect(
      tracker.overdueTasks.find((i) => i.entityId === overdue.id),
    ).toMatchObject({ type: "overdue_task", entityType: "task" });
    expect(
      tracker.pastDuePlannedExpenses.find(
        (i) => i.entityId === pastDuePlanned.id,
      ),
    ).toMatchObject({
      type: "past_due_planned_expense",
      entityType: "expense",
    });
  });

  it("excludes rows belonging to a deleted project", async () => {
    const { output: project } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "tracker deleted project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const { output: task } = await createTask(
      ctx.db,
      taskCreateInput.parse({
        trade: "other",
        name: "tracker deleted overdue task",
        projectId: project.id,
        dueDate: householdDaysAgo(3),
      }),
      ctx.actor,
    );
    const { output: planned } = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        trade: "other",
        costType: "materials",
        name: "tracker deleted planned expense",
        projectId: project.id,
        cost: 100,
        future: true,
        date: householdDaysAgo(5),
      }),
      ctx.actor,
    );

    // Sanity: they're flagged while live.
    const before = await findTrackerProblems(ctx.db);
    expect(before.overdueTasks.map((i) => i.entityId)).toContain(task.id);
    expect(before.pastDuePlannedExpenses.map((i) => i.entityId)).toContain(
      planned.id,
    );

    // A project can only be deleted once its tasks/expenses are (the delete
    // guards enforce that), so removing the project removes the whole subtree.
    await deleteTasks(ctx.db, [task.id], ctx.actor);
    await deleteExpenses(ctx.db, [planned.id], ctx.actor);
    await deleteProjects(ctx.db, [project.id], ctx.actor);

    const after = await findTrackerProblems(ctx.db);
    const everyEntityId = Object.values(after).flatMap((items) =>
      items.map((i) => i.entityId),
    );
    expect(everyEntityId).not.toContain(task.id);
    expect(everyEntityId).not.toContain(planned.id);
    expect(everyEntityId).not.toContain(project.id);
  });

  // A budget estimate is a FORECAST, so asking for one on finished work is
  // busywork that can never be satisfied meaningfully. This dominated the real
  // count: 29 of 32 flagged projects were `done` (a completed wedding, a
  // replaced furnace, a 2023 garden). `stalled_project` already scoped itself
  // to live projects; `missing_budget` simply didn't.
  it("asks for a budget only on live projects, not finished ones", async () => {
    const spend = async (projectId: ProjectShortcode, name: string) => {
      await createExpense(
        ctx.db,
        expenseCreateInput.parse({
          date: "2024-01-15",
          trade: "other",
          costType: "materials",
          name,
          projectId,
          cost: 500,
        }),
        ctx.actor,
      );
    };

    const { output: live } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "budget live project",
        status: "in_progress",
      }),
      ctx.actor,
    );
    const { output: finished } = await createProject(
      ctx.db,
      projectCreateInput.parse({
        name: "budget finished project",
        status: "done",
      }),
      ctx.actor,
    );
    // Both have spend and neither has a cost estimate — the only difference is
    // status, so status alone must decide.
    await spend(live.id, "budget live spend");
    await spend(finished.id, "budget finished spend");

    const tracker = await findTrackerProblems(ctx.db);
    const flagged = tracker.projectsMissingBudget.map((i) => i.entityId);

    expect(flagged).toContain(live.id);
    expect(flagged).not.toContain(finished.id);
  });
});

// The recount-staleness detectors (tenet 1: only a deliberate recount restores
// inventory truth). All three are cheap SQL in the `fast` group, so drive them
// through findFastProblems rather than the full findAllProblems scan.
describe("problems service — recount staleness", () => {
  const ctx = withTestDb();
  const amount = { value: 2, unit: "each" };
  const daysAgo = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // A stocked location: one live entry of a fresh product, never verified.
  const seedStocked = async (name: string) => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name }),
      ctx.actor,
    );
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: `Widget for ${name}` }),
      ctx.actor,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      { productId: prod.id, locationId: loc.id, amount },
      ctx.actor,
    );
    return { loc, product: prod, entry };
  };

  const setLastRecount = (locationId: LocationId, at: Date) =>
    getDb(ctx.db)
      .update(locationTable)
      .set({ lastBulkInventory: at })
      .where(eq(locationTable.id, locationId));

  it("flags stocked locations never recounted or recounted long ago, not fresh ones", async () => {
    const never = await seedStocked("Never-recounted shelf");
    const long = await seedStocked("Long-ago shelf");
    const fresh = await seedStocked("Freshly-recounted shelf");
    await setLastRecount(long.loc.entityId, daysAgo(90));
    await setLastRecount(fresh.loc.entityId, daysAgo(3));

    const { staleLocations } = await findFastProblems(ctx.db);
    const ids = staleLocations.map((l) => l.id);
    expect(ids).toContain(never.loc.id);
    expect(ids).toContain(long.loc.id);
    expect(ids).not.toContain(fresh.loc.id);

    const row = staleLocations.find((l) => l.id === never.loc.id);
    expect(row?.itemCount).toBe(1);
    expect(row?.lastBulkInventory).toBeNull();
  });

  it("ignores locations with no live stock (empty, or emptied by a soft delete)", async () => {
    const empty = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Empty bin" }),
      ctx.actor,
    );
    const emptied = await seedStocked("Emptied bin");
    await deleteInventoryEntries(ctx.db, [emptied.entry.entityId], ctx.actor);

    const { staleLocations } = await findFastProblems(ctx.db);
    const ids = staleLocations.map((l) => l.id);
    // Nothing to recount — findEmptyLocations already owns these.
    expect(ids).not.toContain(empty.id);
    expect(ids).not.toContain(emptied.loc.id);
  });

  it("lists never-verified entries, and drops them once verified or deleted", async () => {
    const unverified = await seedStocked("Unverified bin");
    const verified = await seedStocked("Verified bin");
    const removed = await seedStocked("Removed bin");
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ verifiedAt: new Date() })
      .where(eq(inventoryEntry.id, verified.entry.entityId));
    await deleteInventoryEntries(ctx.db, [removed.entry.entityId], ctx.actor);

    const { neverVerifiedInventory } = await findFastProblems(ctx.db);
    const ids = neverVerifiedInventory.map((i) => i.id);
    expect(ids).toContain(unverified.entry.id);
    expect(ids).not.toContain(verified.entry.id);
    expect(ids).not.toContain(removed.entry.id);

    // Rows carry both refs so the card can link product AND location.
    expect(
      neverVerifiedInventory.find((i) => i.id === unverified.entry.id),
    ).toMatchObject({
      product: { id: unverified.product.id },
      location: { id: unverified.loc.id, name: "Unverified bin" },
    });
  });

  it("flags only items parked in the global Unknown location", async () => {
    const unknown = await ensureGlobalUnknownLocation(ctx.db, ctx.actor);
    const parkedProduct = await createProduct(
      ctx.db,
      makeProductInput({ name: "Parked widget" }),
      ctx.actor,
    );
    const parked = await createInventoryEntry(
      ctx.db,
      { productId: parkedProduct.id, locationId: unknown.id, amount },
      ctx.actor,
    );
    const filed = await seedStocked("Properly filed shelf");

    const { unknownParkedItems } = await findFastProblems(ctx.db);
    expect(unknownParkedItems.map((i) => i.id)).toContain(parked.id);
    expect(unknownParkedItems.map((i) => i.id)).not.toContain(filed.entry.id);
    // The location ref is what lets the Problems card offer a recount rooted at
    // Unknown — the only thing that actually drains it.
    expect(unknownParkedItems.find((i) => i.id === parked.id)).toMatchObject({
      product: { id: parkedProduct.id, name: "Parked widget" },
      location: { name: "Unknown" },
    });

    // Filing it away (here: soft-deleting the parked row) clears the problem.
    await deleteInventoryEntries(ctx.db, [parked.entityId], ctx.actor);
    const after = await findFastProblems(ctx.db);
    expect(after.unknownParkedItems.map((i) => i.id)).not.toContain(parked.id);
  });

  // The detector used to `.limit(25)`, which reported 25 for a real population
  // of 178 — a number that was both wrong and impossible to drive to zero.
  // Uncapping is safe because the section is coverage, not a defect: it's a
  // meter, and rendering is bounded by SectionGroup's show-all toggle.
  it("returns every never-verified entry, not a capped sample", async () => {
    const loc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Uncapped bin" }),
      ctx.actor,
    );
    // One entry per product: (productId, locationId) is unique, so a bigger
    // sample needs distinct products rather than repeated rows.
    const seeded = 30;
    for (let i = 0; i < seeded; i++) {
      const prod = await createProduct(
        ctx.db,
        makeProductInput({ name: `Uncapped widget ${i}` }),
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        { productId: prod.id, locationId: loc.id, amount },
        ctx.actor,
      );
    }

    const { neverVerifiedInventory } = await findFastProblems(ctx.db);
    const inBin = neverVerifiedInventory.filter(
      (i) => i.location.id === loc.id,
    );
    expect(inBin).toHaveLength(seeded);
  });
});

// The defect/coverage split. `totalProblems` — the navbar badge, the homepage
// banner, the headline card — must count only rows that can reach zero;
// coverage rows (un-itemized bins, un-photographed tools, un-recounted shelves)
// never can, and folding them in is what made the badge permanently red.
describe("problems service — totals count defects only", () => {
  const ctx = withTestDb();

  it("excludes coverage sections from totalProblems but still lists them", async () => {
    // An empty leaf location is coverage; an orphaned product is a defect.
    const emptyLoc = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Totals empty bin" }),
      ctx.actor,
    );
    const orphan = await createProduct(
      ctx.db,
      makeProductInput({ name: "Totals orphan widget" }),
      ctx.actor,
    );

    const all = await findAllProblems(
      ctx.db,
      fakeUpcClient().client,
      fakeUsdaClient(),
    );

    // Both are detected...
    expect(all.emptyLocations.map((l) => l.id)).toContain(emptyLoc.id);
    expect(all.orphanedProducts.map((p) => p.id)).toContain(orphan.id);

    // ...but only the defect moves the total. Compare against the summed
    // defect sections rather than a literal, since the shared fixture DB may
    // carry unrelated rows.
    const defectSum = sumProblemSections(
      Object.fromEntries(
        Object.entries(all).filter(([, v]) => Array.isArray(v)),
      ) as Record<string, readonly unknown[]>,
      "defect",
    );
    expect(all.totalProblems).toBe(defectSum);
    expect(all.emptyLocations.length).toBeGreaterThan(0);

    // countProblems reports the two populations separately, and byType keeps
    // the FULL roster so per-detector consumers and MCP slices still work.
    const counts = countProblems(all);
    expect(counts.total).toBe(all.totalProblems);
    expect(counts.coverageTotal).toBeGreaterThanOrEqual(
      all.emptyLocations.length,
    );
    expect(counts.byType.emptyLocations).toBe(all.emptyLocations.length);
  });
});

describe("problems — brand-label spelling variants", () => {
  const ctx = withTestDb();

  const seedProduct = (name: string, manufacturer: string) =>
    createProduct(ctx.db, makeProductInput({ name, manufacturer }), ctx.actor);

  /**
   * A product carrying a spelling that drifts from an established one.
   *
   * It has to go in through the EDIT path, because the create path no longer
   * lets drift in: `resolveEstablishedManufacturer` snaps a new product onto
   * the spelling already in use. That's not a test workaround — it's the only
   * remaining door, and therefore the case these detectors now exist for.
   * Seeding a throwaway brand first keeps the create from snapping onto the
   * very spelling the test is trying to drift away from.
   */
  const seedVariantSpelling = async (name: string, manufacturer: string) => {
    const created = await seedProduct(name, `pending ${name}`);
    await updateProduct(ctx.db, created.entityId, { manufacturer }, ctx.actor);
    return created;
  };

  it("flags the minority spelling of a manufacturer, pointing at the majority", async () => {
    await seedProduct("Ryobi drill", "Ryobi");
    await seedProduct("Ryobi saw", "Ryobi");
    const odd = await seedVariantSpelling("Ryobi sander", "RYOBI");

    const { manufacturerSpellingVariants } = await findFastProblems(ctx.db);
    expect(manufacturerSpellingVariants).toEqual([
      {
        value: "RYOBI",
        count: 1,
        canonical: "Ryobi",
        canonicalCount: 2,
        sampleId: odd.id,
      },
    ]);
  });

  it("ignores the (unspecified) manufacturer sentinel", async () => {
    // The sentinel is carried by ~40% of products; it is not a brand, so two
    // products sharing it must never read as a spelling collision.
    await seedProduct("mystery a", UNSPECIFIED_MANUFACTURER);
    await seedProduct("mystery b", UNSPECIFIED_MANUFACTURER);

    const { manufacturerSpellingVariants } = await findFastProblems(ctx.db);
    expect(manufacturerSpellingVariants).toEqual([]);
  });

  it("excludes the sentinel however it is cased or spaced", async () => {
    // A case-sensitive `<>` would let these through the exclusion, and then
    // canonicalKey would fold them onto the same `unspecified` key as the
    // correctly-cased rows — reporting the not-a-brand sentinel as a brand
    // spelling variant, the exact false positive this detector avoids. The
    // exclusion compares canonical keys, so casing and spacing can't matter.
    await seedProduct("mystery a", UNSPECIFIED_MANUFACTURER);
    await seedProduct("mystery b", UNSPECIFIED_MANUFACTURER);
    // Through the edit path — a create would snap all three onto the correctly
    // cased sentinel and the exclusion would never be exercised.
    await seedVariantSpelling("mystery c", "(Unspecified)");
    await seedVariantSpelling("mystery d", "(UNSPECIFIED)");
    await seedVariantSpelling("mystery e", " (unspecified) ");

    const { manufacturerSpellingVariants } = await findFastProblems(ctx.db);
    expect(manufacturerSpellingVariants).toEqual([]);
  });

  it("clears once the odd spelling is soft-deleted", async () => {
    await seedProduct("Milwaukee drill", "Milwaukee");
    const odd = await seedVariantSpelling("Milwaukee saw", "MILWAUKEE");

    const before = await findFastProblems(ctx.db);
    expect(before.manufacturerSpellingVariants).toHaveLength(1);

    await deleteProducts(ctx.db, [odd.entityId], ctx.actor);

    const after = await findFastProblems(ctx.db);
    expect(after.manufacturerSpellingVariants).toEqual([]);
  });
});

describe("problems — duplicate vendors", () => {
  const ctx = withTestDb();

  // Seed through the door the duplicates actually come in: `createExpense`
  // resolves its `vendor` name via findOrCreateVendor, which matches EXACTLY, so
  // a second spelling mints a second roster row. Each distinct orderId is a
  // separate charge on that vendor, which is what the detector weighs.
  const seedCharge = (vendor: string, orderId: string) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({
            name: `${vendor} ${orderId}`,
            cost: 10,
            vendor,
            orderId,
          }),
        ),
        ctx.actor,
      ),
    );

  // Idempotent by contract (vendor.integration.test pins it), so this reads an
  // existing roster row's internal uuid rather than creating anything.
  // The detector rows expose these entities by their canonical public ids.
  const vendorUuidOf = (name: string) => findOrCreateVendor(ctx.db, name);

  it("pairs two spellings of one vendor, keeping the one with more charges", async () => {
    await seedCharge("Amazon", "AMZ-1");
    await seedCharge("Amazon", "AMZ-2");
    await seedCharge("amazon", "AMZ-3");

    const { duplicateVendors } = await findFastProblems(ctx.db);
    const sampleUuid = await vendorUuidOf("amazon");
    const canonicalUuid = await vendorUuidOf("Amazon");
    const sample = await getVendorByID(ctx.db, sampleUuid);
    const canonicalSample = await getVendorByID(ctx.db, canonicalUuid);
    expect(duplicateVendors).toEqual([
      {
        value: "amazon",
        // Live CHARGES, not roster rows: `Vendor.name` is unique among live rows,
        // so a row count would be 1 on both sides and the canonical pick would
        // fall through to alphabetical order.
        count: 1,
        canonical: "Amazon",
        canonicalCount: 2,
        sampleId: sample.id,
        canonicalSampleId: canonicalSample.id,
      },
    ]);
    // A duplicate roster row is wrong and drivable to zero, so unlike the
    // advisory stated-total worklist it counts toward the badge.
    expect(PROBLEM_CLASS.duplicateVendors).toBe("defect");
  });

  it("leaves vendors that are each spelled one way alone", async () => {
    await seedCharge("Tool Nirvana", "TN-1");
    await seedCharge("Home Depot", "HD-1");
    await seedCharge("Home Depot", "HD-2");

    const { duplicateVendors } = await findFastProblems(ctx.db);
    expect(duplicateVendors).toEqual([]);
  });

  it("does not fold an abbreviation, only a respelling", async () => {
    // `bh` vs `bhphoto` are different canonical keys. This pair was real and was
    // merged by hand — the detector deliberately doesn't guess at it, so the UI
    // copy must not claim it does.
    await seedCharge("B&H", "BH-1");
    await seedCharge("B&H Photo", "BH-2");

    const { duplicateVendors } = await findFastProblems(ctx.db);
    expect(duplicateVendors).toEqual([]);
  });

  it("clears once merged with the two ids the row carries", async () => {
    // The row's own `canonicalSampleId`/`sampleId` are exactly
    // what the Problems card hands `mergeVendors` (which now speaks
    // shortcodes) — this pins that they're the right way round.
    await seedCharge("Lowes", "LW-1");
    await seedCharge("Lowes", "LW-2");
    await seedCharge("Lowe's", "LW-3");

    const before = await findFastProblems(ctx.db);
    expect(before.duplicateVendors).toHaveLength(1);
    const row = before.duplicateVendors[0];
    if (!row) throw new Error("expected a duplicate-vendor row");
    expect(row.value).toBe("Lowe's");

    const keeper = await mergeVendors(
      ctx.db,
      {
        keepId: row.canonicalSampleId,
        mergeIds: [row.sampleId],
      },
      ctx.actor,
    );
    expect(keeper.name).toBe("Lowes");
    // All three charges are now the keeper's — the merge moved them rather than
    // stranding them on a soft-deleted vendor.
    expect(keeper.purchaseCount).toBe(3);

    const after = await findFastProblems(ctx.db);
    expect(after.duplicateVendors).toEqual([]);
  });
});

describe("problems — vendor mini-logo coverage", () => {
  const ctx = withTestDb();

  const seedLine = (vendor: string, orderId: string) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(
          makeExpenseInput({ name: `${vendor} ${orderId}`, vendor, orderId }),
        ),
        ctx.actor,
      ),
    );

  it("lists only active unseeded vendors and weights them by ledger visibility", async () => {
    await findOrCreateVendor(ctx.db, "Unused Roster Vendor");
    await seedLine("Quiet Unseeded Vendor", "Q-1");
    await seedLine("Busy Unseeded Vendor", "B-1");
    await seedLine("Busy Unseeded Vendor", "B-2");

    const { vendorsWithoutLogos } = await findFastProblems(ctx.db);

    expect(vendorsWithoutLogos.map((row) => row.name)).toEqual([
      "Busy Unseeded Vendor",
      "Quiet Unseeded Vendor",
    ]);
    expect(vendorsWithoutLogos[0]).toMatchObject({
      purchaseCount: 2,
      expenseRowCount: 2,
    });
    expect(PROBLEM_CLASS.vendorsWithoutLogos).toBe("coverage");
    expect((await findCoverageTotals(ctx.db)).vendorsWithPurchases).toBe(2);
  });

  it("excludes a vendor whose public shortcode is in the generated manifest", async () => {
    const [seededShortcode] = Object.keys(VENDOR_LOGO_BY_SHORTCODE);
    if (!seededShortcode) throw new Error("expected a seeded vendor logo");

    await seedLine("Manifest-backed Vendor", "M-1");
    const vendorId = await findOrCreateVendor(ctx.db, "Manifest-backed Vendor");
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ shortcode: seededShortcode })
      .where(eq(vendorTable.id, vendorId));

    const { vendorsWithoutLogos } = await findFastProblems(ctx.db);
    expect(vendorsWithoutLogos).toEqual([]);
  });

  it("excludes soft-deleted expense lines from the visibility count", async () => {
    const keep = await seedLine("Deletion-count Vendor", "D-1");
    const remove = await seedLine("Deletion-count Vendor", "D-2");
    await deleteExpenses(ctx.db, [remove.id], ctx.actor);

    const { vendorsWithoutLogos } = await findFastProblems(ctx.db);
    expect(vendorsWithoutLogos).toEqual([
      expect.objectContaining({
        name: "Deletion-count Vendor",
        purchaseCount: 2,
        expenseRowCount: 1,
      }),
    ]);
    expect(keep.id).not.toBe(remove.id);
  });
});

describe("problems — charges not reconciling", () => {
  const ctx = withTestDb();

  // A charge is minted by the expense write (findOrCreateVendor +
  // findOrCreatePurchase on vendor+orderId), so two lines sharing an order id
  // land on ONE charge. `statedTotal` is charge-level and is set afterwards —
  // there is deliberately no path that derives it from the lines.
  const seedLine = (overrides: Partial<ExpenseCreateInput>) =>
    unwrap(
      createExpense(
        ctx.db,
        expenseCreateInput.parse(makeExpenseInput(overrides)),
        ctx.actor,
      ),
    );

  const setStated = (id: PurchaseShortcode, statedTotal: number) =>
    unwrap(
      updatePurchase(
        ctx.db,
        purchaseUpdateInput.parse({ id, data: { statedTotal } }),
        ctx.actor,
      ),
    );

  it("flags charges whose lines don't add up, biggest gap first, and leaves a matching one alone", async () => {
    const big = await seedLine({
      name: "big gap line",
      cost: 300,
      vendor: "Reconcile Depot",
      orderId: "RD-BIG",
    });
    const small = await seedLine({
      name: "small gap line",
      cost: 85,
      vendor: "Reconcile Depot",
      orderId: "RD-SMALL",
    });
    // Two lines on one order = one charge with two lines, which is the case a
    // charge-level stated total exists to check.
    const okFirst = await seedLine({
      name: "matching line a",
      cost: 60,
      vendor: "Reconcile Depot",
      orderId: "RD-OK",
    });
    const okSecond = await seedLine({
      name: "matching line b",
      cost: 40,
      vendor: "Reconcile Depot",
      orderId: "RD-OK",
    });
    expect(okSecond.purchaseId).toBe(okFirst.purchaseId);

    const bigCharge = await setStated(big.purchaseId as PurchaseShortcode, 500);
    const smallCharge = await setStated(
      small.purchaseId as PurchaseShortcode,
      100,
    );
    const okCharge = await setStated(
      okFirst.purchaseId as PurchaseShortcode,
      100,
    );

    const { purchasesNotReconciling } = await findFastProblems(ctx.db);

    // The detector's id is the canonical public purchase id.
    // Ordered by the size of the discrepancy: $200 before $15.
    expect(purchasesNotReconciling.map((c) => c.id)).toEqual([
      bigCharge.id,
      smallCharge.id,
    ]);
    expect(purchasesNotReconciling.map((c) => c.id)).not.toContain(okCharge.id);
    expect(purchasesNotReconciling[1]).toMatchObject({
      id: smallCharge.id,
      vendorName: "Reconcile Depot",
      orderId: "RD-SMALL",
      statedTotal: 100,
      expenseTotal: 85,
      expenseCount: 1,
    });
  });

  it("doesn't compare a charge with no stated total recorded", async () => {
    // `statedTotal` is null on ~every charge (nobody has keyed the paperwork in
    // yet), which reconciles as "unknown" — absence of a claim is not a
    // discrepancy, and flagging it would make the section permanently full.
    await seedLine({
      name: "no paperwork line",
      cost: 42,
      vendor: "No Paperwork Co",
      orderId: "NP-1",
    });

    const { purchasesNotReconciling } = await findFastProblems(ctx.db);
    expect(purchasesNotReconciling).toEqual([]);
  });

  it("sums only live lines, so emptying one re-opens the discrepancy", async () => {
    const kept = await seedLine({
      name: "kept portion",
      cost: 60,
      vendor: "Refund Mart",
      orderId: "RM-1",
    });
    const refunded = await seedLine({
      name: "refunded portion",
      cost: 40,
      vendor: "Refund Mart",
      orderId: "RM-1",
    });
    const charge = await setStated(kept.purchaseId as PurchaseShortcode, 100);

    const before = await findFastProblems(ctx.db);
    expect(before.purchasesNotReconciling).toEqual([]);

    await deleteExpenses(ctx.db, [refunded.id], ctx.actor);

    const after = await findFastProblems(ctx.db);
    expect(after.purchasesNotReconciling).toMatchObject([
      {
        id: charge.id,
        statedTotal: 100,
        expenseTotal: 60,
        expenseCount: 1,
      },
    ]);
  });

  it("excludes differences fully explained by posted refund evidence", async () => {
    const line = await seedLine({
      name: "refund-adjusted purchase",
      cost: 60,
      vendor: "Posted Refund Mart",
      orderId: "PRM-1",
    });
    const charge = await setStated(line.purchaseId as PurchaseShortcode, 100);
    const purchaseId = unsafePurchaseId(
      (await resolveLiveShortcode(ctx.db, charge.id, "purchase"))!,
    );
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Posted Refund Card",
      identity: {
        kind: "credit_card",
        issuer: null,
        network: "visa",
        last4: "4040",
      },
      provisional: false,
      sourceAliases: [],
      notes: null,
    });
    const refund = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: account.id,
      purchaseId,
      kind: "refund",
      status: "pending",
      amount: -40,
      transactionDate: "2026-07-02",
      postedDate: null,
      merchant: "Posted Refund Mart",
      rawDescription: null,
      sourceCategory: null,
      sourceRefs: [],
      notes: null,
    });

    expect(
      (await findFastProblems(ctx.db)).purchasesNotReconciling,
    ).toHaveLength(1);

    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ status: "posted", postedDate: "2026-07-03" })
      .where(eq(financialTransaction.id, refund.id));

    expect((await findFastProblems(ctx.db)).purchasesNotReconciling).toEqual(
      [],
    );
  });

  it("is advisory: reported, but never counted as a defect", async () => {
    const line = await seedLine({
      name: "advisory line",
      cost: 85,
      vendor: "Advisory Mart",
      orderId: "AM-1",
    });
    await setStated(line.purchaseId as PurchaseShortcode, 100);

    const { purchasesNotReconciling } = await findFastProblems(ctx.db);
    expect(purchasesNotReconciling).toHaveLength(1);
    // A mismatch is frequently correct (a partial refund), so it must never
    // reach `totalProblems` or the navbar badge.
    expect(PROBLEM_CLASS.purchasesNotReconciling).not.toBe("defect");
    expect(sumProblemSections({ purchasesNotReconciling }, "defect")).toBe(0);
  });
});
