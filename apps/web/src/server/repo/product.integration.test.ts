import { type ProductId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import {
  type ProductFilters,
  productWithFoodOut,
} from "@cubby/schemas/product";
import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import type { FoodSummary } from "@cubby/usda-schemas";
import { and, eq, sql } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  image,
  inventoryEntry,
  location,
  locationImage,
  productExternalId,
  productImage,
  product as productTable,
  productUnitMappings,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { getAuditLog } from "./audit-log";
import { getDb, insertAndReturn, notDeleted } from "./database-helpers";
import { createExpense, deleteExpenses } from "./expense";
import { deleteInventoryEntries, inventoryentryList } from "./inventory";
import { updateLocation } from "./location";
import {
  deleteProducts,
  findProductByGtin,
  findProductByNameFuzzyManufacturer,
  getProductByID,
  getProductPickerItemsByIds,
  getProductsByShortcodes,
  patchProductExternalIds,
  productList,
  quickCreateProduct,
  setProductsStockTracked,
  updateProduct,
} from "./product";
import { attachProductComponents } from "./product-components";
import { readProductDetail } from "./product/detail";
import { loadProductQuantityLedgers } from "./product/quantity-ledger";
import { createProject } from "./project";
import {
  attachPurchaseProducts,
  detachPurchaseProducts,
} from "./purchase-products";
import {
  createImageFixture,
  createIngredientFixture as createIngredient,
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
import { insertWithShortcode } from "./shortcode-utils";
import { createTask, deleteTasks } from "./task";
import { findOrCreateVendor } from "./vendor";
import { createWish, deleteWishes } from "./wish";

describe("product repository", () => {
  const ctx = withTestDb();

  // Measured with countTestDbQueries against the current detail reader; keep
  // these as statement ceilings so an accidental N+1 fails deterministically.
  const PRODUCT_DETAIL_QUERY_BUDGET_LEAN = 11;
  const PRODUCT_DETAIL_QUERY_BUDGET_DATA_RICH = 16;

  const readProductDetailThroughKernel = async (shortcode: string) => {
    // The test context stubs USDA misses; these fixtures deliberately omit
    // UPC/FDC identifiers so the budget measures the database detail path,
    // not an external enrichment call.
    const result = await executeEntity(
      requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
      {
        action: "get",
        entity: "product",
        id: shortcode,
        missing: "null",
      },
    );
    if (result.action !== "get") throw new Error("unreachable");
    return result.item === null ? null : productWithFoodOut.parse(result.item);
  };

  it("keeps a lean product detail within its query budget", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Query Budget Lean Product" }),
      ctx.actor,
    );

    const measured = await countTestDbQueries(() =>
      readProductDetailThroughKernel(product.id),
    );

    expect(measured.result?.id).toBe(product.id);
    expect(measured.queryCount).toBeLessThanOrEqual(
      PRODUCT_DETAIL_QUERY_BUDGET_LEAN,
    );
  });

  it("returns null for invalid, wrong-entity, unknown, and deleted shortcodes", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Detail Boundary Product" }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Detail Boundary Location" }),
      ctx.actor,
    );
    const request = createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    });
    const context = { db: ctx.db, usdaClient: request.usdaClient };

    await expect(readProductDetail(context, "not-a-code")).resolves.toBeNull();
    await expect(readProductDetail(context, location.id)).resolves.toBeNull();
    await expect(readProductDetail(context, "PRD-2222")).resolves.toBeNull();

    await getDb(ctx.db)
      .update(productTable)
      .set({ deletedAt: new Date() })
      .where(eq(productTable.id, product.entityId));

    await expect(readProductDetail(context, product.id)).resolves.toBeNull();
  });

  it("keeps a data-rich product detail within its query budget", async () => {
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Query Budget Ingredient", aliases: ["qbi"] },
      ctx.actor,
    );
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Query Budget Recipe",
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Use it" }],
            ingredients: [ingredientRef(ingredient.id)],
          },
        ],
      }),
      ctx.actor,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Query Budget Data-Rich Product",
        manufacturer: "(unspecified)",
        ingredientId: ingredient.id,
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0QUERYBUD01",
            url: null,
          },
          {
            source: "home-depot",
            kind: "retailer_sku",
            externalId: "B0QUERYBUD02",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Query Budget Purchase",
        productId: product.id,
        productQuantity: 2,
        cost: 10,
      }),
      ctx.actor,
    );
    const cover = await createImageFixture(
      ctx.db,
      "query-budget-data-rich-cover",
    );
    await insertAndReturn(ctx.db, productImage, {
      productId: product.entityId,
      imageId: cover.id,
    });
    const room = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Query Budget Room", type: "room" }),
      ctx.actor,
    );
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Query Budget Shelf",
        type: "shelf",
        parentId: room.id,
      }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.id,
        locationId: shelf.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    const request = createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    });
    const detailContext = { db: ctx.db, usdaClient: request.usdaClient };
    const singleRow = await countTestDbQueries(() =>
      readProductDetail(detailContext, product.id),
    );

    const garage = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Query Budget Garage", type: "room" }),
      ctx.actor,
    );
    const secondShelf = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Query Budget Second Shelf",
        type: "shelf",
        parentId: garage.id,
      }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.id,
        locationId: secondShelf.id,
        amount: { value: 3, unit: "each" },
      },
      ctx.actor,
    );
    const deletedShelf = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Query Budget Deleted Shelf",
        type: "shelf",
        parentId: room.id,
      }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: product.id,
        locationId: deletedShelf.id,
        amount: { value: 99, unit: "each" },
      },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(location)
      .set({ deletedAt: new Date() })
      .where(eq(location.id, deletedShelf.entityId));

    const measured = await countTestDbQueries(() =>
      readProductDetailThroughKernel(product.id),
    );
    const optimized = await countTestDbQueries(() =>
      readProductDetail(detailContext, product.id),
    );

    expect(measured.result?.id).toBe(product.id);
    expect(measured.result?.inventoryEntry).toHaveLength(2);
    expect(measured.result?.externalIds).toHaveLength(2);
    expect(measured.result?.pricing).toMatchObject({
      effectivePrice: 5,
      source: "derived",
      knownExpenseCount: 1,
      knownUnitCount: 2,
    });
    expect(measured.result?.quantityLedger).toMatchObject({
      acquiredUnits: 2,
      exitedUnits: 0,
      expectedQuantity: 2,
      locationCount: 0,
    });
    expect(measured.result?.onHandUnits).toBe(5);
    expect(
      measured.result?.inventoryEntry.map((entry) => [
        entry.location.name,
        entry.location.ancestors.at(-1)?.name,
      ]),
    ).toEqual([
      ["Query Budget Shelf", "Query Budget Room"],
      ["Query Budget Second Shelf", "Query Budget Garage"],
    ]);
    expect(measured.result?.dataQuality.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "product_manufacturer" }),
      ]),
    );
    expect(measured.result?.recipeUsages).toEqual([
      expect.objectContaining({
        recipe: expect.objectContaining({ id: recipe.id, name: recipe.name }),
      }),
    ]);
    expect(optimized.result).toEqual(measured.result);
    expect(optimized.queryCount).toBe(singleRow.queryCount);
    expect(measured.queryCount).toBeLessThanOrEqual(
      PRODUCT_DETAIL_QUERY_BUDGET_DATA_RICH,
    );
  });

  it("returns linked ingredient IDs with a bulk delete", async () => {
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Deleted Product Ingredient", aliases: [] },
      ctx.actor,
    );
    const first = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Deleted Product Ingredient First",
        ingredientId: ingredient.id,
      }),
      ctx.actor,
    );
    const second = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Deleted Product Ingredient Second",
        ingredientId: ingredient.id,
      }),
      ctx.actor,
    );

    const result = await deleteProducts(
      ctx.db,
      [first.entityId, second.entityId],
      ctx.actor,
    );

    expect(result.ingredientIds).toEqual([ingredient.entityId]);
  });

  it("uses explicit food identifiers while retaining external IDs", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Direct Food Detail",
        fdc_id: 123456,
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0DIRECTFOOD",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    const food = {
      fdc_id: 123456,
      foodInfo: {
        data_type: "foundation_food",
        description: "Direct Test Food",
      },
      brandedFoodInfo: null,
      legacyFoodInfo: null,
      nutritionInfo: { nutrientSummary: [], nutrientsPer100: {} },
      portionInfoRaw: [],
    } satisfies FoodSummary;
    const request = createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    });
    const findFood = vi
      .spyOn(request.usdaClient, "findFood")
      .mockResolvedValue(food);

    const detail = await readProductDetail(
      { db: ctx.db, usdaClient: request.usdaClient },
      product.id,
    );

    expect(findFood).toHaveBeenCalledWith({ kind: "fdc", fdc_id: 123456 });
    expect(detail?.food).toEqual(food);
    expect(detail?.externalIds).toEqual([
      expect.objectContaining({
        source: "amazon",
        kind: "asin",
        externalId: "B0DIRECTFOOD",
      }),
    ]);
  });

  it("should create a product and retrieve it by ID", async () => {
    const productData = makeProductInput({ upc: "123456789012" });

    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    expect(createdProduct.id).toBeDefined();
    expect(createdProduct.name).toEqual(productData.name);
    expect(createdProduct.manufacturer).toEqual(productData.manufacturer);
    expect(createdProduct.model).toEqual(productData.model);
    expect(createdProduct.primaryGtin).toEqual(
      productData.upc?.padStart(14, "0") ?? null,
    );

    const retrievedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    expect(retrievedProduct.id).toEqual(createdProduct.id);
    expect(retrievedProduct.name).toEqual(productData.name);
    expect(retrievedProduct.manufacturer).toEqual(productData.manufacturer);
    expect(retrievedProduct.unitMappings).toEqual([]);
    expect(retrievedProduct.ingredient).toBeNull();
  });

  it("stores an ISBN as the canonical GTIN and categorizes the physical book", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Theoretical Cookbook",
        category: "supplies",
        isbn: "0-306-40615-2",
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "0306406152",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );

    expect(created.primaryGtin).toBe("09780306406157");
    expect(created.category).toBe("books");
    expect(created.externalIds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "gtin",
          kind: "gtin_14",
          externalId: "09780306406157",
        }),
        expect.objectContaining({
          source: "amazon",
          kind: "asin",
          externalId: "0306406152",
        }),
      ]),
    );

    const byIsbn10 = await productList(
      ctx.db,
      { upcFilter: "0-306-40615-2", categoryFilter: "books" },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(byIsbn10.data.map((row) => row.id)).toContain(created.id);
  });

  it("rejects barcode and ISBN inputs that name different products", async () => {
    await expect(
      createProduct(
        ctx.db,
        makeProductInput({
          name: "Conflicting Codes",
          upc: "123456789012",
          isbn: "0-306-40615-2",
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(/identify different printed products/);
  });

  it("reclassifies an existing Product when a verified ISBN is added", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({ name: "Reference Manual", category: "supplies" }),
      ctx.actor,
    );

    const { product: updated } = await updateProduct(
      ctx.db,
      created.entityId,
      { isbn: "978-0-13-110362-7" },
      ctx.actor,
    );

    expect(updated.primaryGtin).toBe("09780131103627");
    expect(updated.category).toBe("books");
  });

  // A duplicate-identity error has to name the product that is blocking. The
  // name+manufacturer branch used to just echo the caller's own input back,
  // which says a conflict exists without saying what to merge into or skip —
  // so the next call was always a search to find out.
  describe("duplicate identity errors name the blocker", () => {
    it("names the shortcode on a name+manufacturer collision", async () => {
      const first = await createProduct(
        ctx.db,
        makeProductInput({ name: "Bare Grinder", manufacturer: "Ryobi" }),
        ctx.actor,
      );

      await expect(
        createProduct(
          ctx.db,
          makeProductInput({ name: "Bare Grinder", manufacturer: "Ryobi" }),
          ctx.actor,
        ),
      ).rejects.toThrow(new RegExp(`already exists: ${first.id}`));
    });

    // Now raised by `assertExternalIdsAvailable`, the identifier pre-check,
    // rather than by translating a `Product_upc_key` violation after the fact.
    // `throwIfDuplicateProduct`'s barcode branch survives as the race backstop:
    // it only fires when two concurrent creates both pass the pre-check.
    it("names the shortcode on a UPC collision", async () => {
      const first = await createProduct(
        ctx.db,
        makeProductInput({ name: "Barcoded", upc: "033287188048" }),
        ctx.actor,
      );

      await expect(
        createProduct(
          ctx.db,
          makeProductInput({ name: "Different Name", upc: "033287188048" }),
          ctx.actor,
        ),
      ).rejects.toThrow(new RegExp(`already belongs to ${first.id}`));
    });

    it("collides across ENCODINGS of one barcode, not just exact strings", async () => {
      const first = await createProduct(
        ctx.db,
        makeProductInput({ name: "Foam Brush", upc: "077089850017" }),
        ctx.actor,
      );

      await expect(
        createProduct(
          ctx.db,
          makeProductInput({ name: "Foam Brush 13", upc: "0077089850017" }),
          ctx.actor,
        ),
      ).rejects.toThrow(
        new RegExp(
          `gtin/gtin_14/00077089850017 already belongs to ${first.id}`,
        ),
      );
    });

    it("finds a product by a barcode written in another encoding", async () => {
      const created = await createProduct(
        ctx.db,
        makeProductInput({ name: "Scanned Item", upc: "0077089850017" }),
        ctx.actor,
      );

      const found = await findProductByGtin(ctx.db, "077089850017");
      expect(found?.id).toBe(created.id);
      expect(found?.primaryGtin).toBe("00077089850017");
    });

    it("keeps both when one update carries a barcode AND externalIds", async () => {
      const created = await createProduct(
        ctx.db,
        makeProductInput({ name: "Both At Once" }),
        ctx.actor,
      );

      await updateProduct(
        ctx.db,
        created.entityId,
        {
          upc: "0012345678905",
          externalIds: [
            {
              source: "amazon",
              kind: "asin",
              externalId: "B0TESTBOTH",
              url: null,
            },
          ],
        },
        ctx.actor,
      );

      const live = await getDb(ctx.db).query.productExternalId.findMany({
        where: and(
          eq(productExternalId.productId, created.entityId),
          notDeleted(productExternalId),
        ),
        columns: { source: true, externalId: true, isPrimary: true },
      });
      expect(live).toEqual(
        expect.arrayContaining([
          { source: "gtin", externalId: "00012345678905", isPrimary: true },
          { source: "amazon", externalId: "B0TESTBOTH", isPrimary: true },
        ]),
      );
      expect(live).toHaveLength(2);
    });

    it("clearing the barcode retires the primary and promotes a secondary", async () => {
      const created = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Two Barcodes",
          upc: "0012345678905",
          externalIds: [
            {
              source: "gtin",
              kind: "gtin_14",
              externalId: "00099999999992",
              isPrimary: false,
              url: null,
            },
          ],
        }),
        ctx.actor,
      );

      await updateProduct(ctx.db, created.entityId, { upc: null }, ctx.actor);

      const live = await getDb(ctx.db).query.productExternalId.findMany({
        where: and(
          eq(productExternalId.productId, created.entityId),
          notDeleted(productExternalId),
        ),
        columns: { externalId: true, isPrimary: true },
      });
      expect(live).toEqual([{ externalId: "00099999999992", isPrimary: true }]);
    });

    it("names the shortcode when a RENAME collides", async () => {
      // updateProduct had no duplicate handler at all, so a rename fell through
      // to the generic translator's "a product with that name, manufacturer
      // already exists" — the one path where the conflicting row was never
      // looked up.
      const taken = await createProduct(
        ctx.db,
        makeProductInput({ name: "Taken Name", manufacturer: "Acme" }),
        ctx.actor,
      );
      const other = await createProduct(
        ctx.db,
        makeProductInput({ name: "Other Name", manufacturer: "Acme" }),
        ctx.actor,
      );

      await expect(
        updateProduct(
          ctx.db,
          other.entityId,
          { name: "Taken Name" },
          ctx.actor,
        ),
      ).rejects.toThrow(new RegExp(`already exists: ${taken.id}`));
    });
  });

  // Regression: this lookup was built as sql`id = ANY(${ids})`. Drizzle expands
  // a JS array in a template into a row constructor, so the query went out as
  // `= ANY(($1))` and postgres rejected it — the product combobox's semantic
  // fallback 500'd at every id count, one included.
  it("hydrates picker items with the first displayable cover", async () => {
    const first = await createProduct(
      ctx.db,
      makeProductInput({ name: "Picker hydrate A" }),
      ctx.actor,
    );
    const second = await createProduct(
      ctx.db,
      makeProductInput({ name: "Picker hydrate B" }),
      ctx.actor,
    );
    const cover = await createImageFixture(ctx.db, "picker-hydrate-cover");
    const manual = await createImageFixture(ctx.db, "picker-hydrate-manual", {
      contentType: PDF_CONTENT_TYPE,
    });
    const missing = await createImageFixture(ctx.db, "picker-hydrate-missing", {
      storageStatus: "missing",
    });
    await updateProduct(
      ctx.db,
      first.entityId,
      {
        pendingImageIds: [
          parseShortcodeFor("image", manual.shortcode),
          parseShortcodeFor("image", cover.shortcode),
        ],
      },
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      second.entityId,
      { pendingImageIds: [parseShortcodeFor("image", missing.shortcode)] },
      ctx.actor,
    );

    const one = await getProductPickerItemsByIds(ctx.db, [first.entityId]);
    expect(one.map((item) => item.id)).toEqual([first.id]);
    expect(one[0]).toMatchObject({ coverImageUrl: cover.url });

    const both = await getProductPickerItemsByIds(ctx.db, [
      first.entityId,
      second.entityId,
    ]);
    expect(both.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(both.map((item) => item.coverImageUrl)).toEqual([cover.url, null]);
  });

  it("supports typed identifier replacement and slot-level patches", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        externalIds: [
          { source: "Amazon ", kind: "asin", externalId: "B0OLD", url: null },
          {
            source: "amazon",
            kind: "retailer_sku",
            externalId: "SKU-1",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    expect(
      created.externalIds.map((entry) => [entry.source, entry.kind]),
    ).toEqual([
      ["amazon", "asin"],
      ["amazon", "retailer_sku"],
    ]);

    await updateProduct(
      ctx.db,
      created.entityId,
      {
        externalIds: [
          {
            id: created.externalIds[0]!.id,
            source: "amazon",
            kind: "asin",
            externalId: "B0REPLACED",
            url: null,
          },
        ],
      },
      ctx.actor,
    );
    await patchProductExternalIds(
      ctx.db,
      created.entityId,
      {
        upsert: [
          {
            source: "amazon",
            kind: "retailer_sku",
            externalId: "SKU-2",
            url: null,
          },
          {
            source: "mcmaster",
            kind: "catalog_number",
            externalId: "123",
            url: null,
          },
        ],
        remove: [],
      },
      ctx.actor,
    );
    await patchProductExternalIds(
      ctx.db,
      created.entityId,
      {
        upsert: [],
        remove: [
          {
            source: "amazon",
            kind: "asin",
            expectedExternalId: "B0REPLACED",
          },
        ],
      },
      ctx.actor,
    );
    const final = await getProductByID(ctx.db, created.entityId);
    expect(
      final.externalIds.map((entry) => [
        entry.source,
        entry.kind,
        entry.externalId,
      ]),
    ).toEqual([
      ["amazon", "retailer_sku", "SKU-2"],
      ["mcmaster", "catalog_number", "123"],
    ]);
  });

  it("holds a second identifier in one slot and promotes on removal", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Two Listings Salt",
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0PRIMARY1",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    await patchProductExternalIds(
      ctx.db,
      created.entityId,
      {
        upsert: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0SECOND01",
            url: null,
            isPrimary: false,
          },
        ],
        remove: [],
      },
      ctx.actor,
    );
    const asins = async () =>
      (await getProductByID(ctx.db, created.entityId)).externalIds
        .filter((entry) => entry.source === "amazon" && entry.kind === "asin")
        .map((entry) => [entry.externalId, entry.isPrimary] as const)
        .sort((a, b) => a[0].localeCompare(b[0]));
    expect(await asins()).toEqual([
      ["B0PRIMARY1", true],
      ["B0SECOND01", false],
    ]);

    await patchProductExternalIds(
      ctx.db,
      created.entityId,
      {
        upsert: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0PRIMARY2",
            url: null,
          },
        ],
        remove: [],
      },
      ctx.actor,
    );
    expect(await asins()).toEqual([
      ["B0PRIMARY2", true],
      ["B0SECOND01", false],
    ]);

    await patchProductExternalIds(
      ctx.db,
      created.entityId,
      {
        upsert: [],
        remove: [
          {
            source: "amazon",
            kind: "asin",
            expectedExternalId: "B0PRIMARY2",
          },
        ],
      },
      ctx.actor,
    );
    expect(await asins()).toEqual([["B0SECOND01", true]]);
  });

  it("keeps a primary in the slot however the rows are patched", async () => {
    // The partial unique forbids TWO primaries, so a slot with ZERO violates
    // nothing — it just silently breaks the next primary upsert, whose
    // `onConflictDoUpdate` arbiter (`isPrimary AND deletedAt IS NULL`) then has
    // no row to match. Both ways of getting there are covered here.
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Primary Invariant Salt",
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0AAA00001",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    const patch = (
      upsert: Parameters<typeof patchProductExternalIds>[2]["upsert"],
      remove: Parameters<typeof patchProductExternalIds>[2]["remove"] = [],
    ) =>
      patchProductExternalIds(
        ctx.db,
        created.entityId,
        { upsert, remove },
        ctx.actor,
      );
    const asins = async () =>
      (await getProductByID(ctx.db, created.entityId)).externalIds
        .filter((entry) => entry.kind === "asin")
        .map((entry) => [entry.externalId, entry.isPrimary] as const)
        .sort((a, b) => a[0].localeCompare(b[0]));

    await patch([
      {
        source: "amazon",
        kind: "asin",
        externalId: "B0BBB00002",
        url: null,
        isPrimary: false,
      },
      {
        source: "amazon",
        kind: "asin",
        externalId: "B0CCC00003",
        url: null,
        isPrimary: false,
      },
    ]);
    expect(await asins()).toEqual([
      ["B0AAA00001", true],
      ["B0BBB00002", false],
      ["B0CCC00003", false],
    ]);

    await patch(
      [],
      [
        { source: "amazon", kind: "asin", expectedExternalId: "B0AAA00001" },
        { source: "amazon", kind: "asin", expectedExternalId: "B0BBB00002" },
      ],
    );
    expect(await asins()).toEqual([["B0CCC00003", true]]);

    // A lone `isPrimary: false` upsert naming the row that is CURRENTLY the
    // primary. The value resolves to that row (the global unique makes it the
    // only one), so it was demoted with nothing left standing for the slot.
    await patch([
      {
        source: "amazon",
        kind: "asin",
        externalId: "B0CCC00003",
        url: null,
        isPrimary: false,
      },
    ]);
    expect(await asins()).toEqual([["B0CCC00003", true]]);

    await patch([
      {
        source: "amazon",
        kind: "asin",
        externalId: "B0CCC00003",
        url: null,
        isPrimary: false,
      },
      { source: "amazon", kind: "asin", externalId: "B0DDD00004", url: null },
    ]);
    expect(await asins()).toEqual([
      ["B0CCC00003", false],
      ["B0DDD00004", true],
    ]);

    await patch([
      { source: "amazon", kind: "asin", externalId: "B0EEE00005", url: null },
    ]);
    expect(await asins()).toEqual([
      ["B0CCC00003", false],
      ["B0EEE00005", true],
    ]);

    await patch([
      { source: "amazon", kind: "asin", externalId: "B0FFF00006", url: null },
      {
        source: "amazon",
        kind: "asin",
        externalId: "B0EEE00005",
        url: null,
        isPrimary: false,
      },
    ]);
    expect(await asins()).toEqual([
      ["B0CCC00003", false],
      ["B0EEE00005", false],
      ["B0FFF00006", true],
    ]);
  });

  it("replaces the identifier set when a demotion and a new primary arrive together", async () => {
    // `syncProductExternalIds` ran creates before updates, so inserting the new
    // primary hit the partial unique while the old primary was still primary —
    // a plain non-deferrable index, so it threw before the demotion could make
    // room. Only expressible once a slot could hold more than one row.
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Demote And Replace Salt",
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0OLD00001",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    await updateProduct(
      ctx.db,
      created.entityId,
      {
        externalIds: [
          {
            id: created.externalIds[0]!.id,
            source: "amazon",
            kind: "asin",
            externalId: "B0OLD00001",
            url: null,
            isPrimary: false,
          },
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0NEW00002",
            url: null,
          },
        ],
      },
      ctx.actor,
    );
    expect(
      (await getProductByID(ctx.db, created.entityId)).externalIds
        .map((entry) => [entry.externalId, entry.isPrimary] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    ).toEqual([
      ["B0NEW00002", true],
      ["B0OLD00001", false],
    ]);
  });

  it("does not mutate any external-ID slot when a removal precondition fails", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0CURRENT",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );

    await expect(
      patchProductExternalIds(
        ctx.db,
        created.entityId,
        {
          upsert: [
            {
              source: "mcmaster",
              kind: "catalog_number",
              externalId: "999",
              url: null,
            },
          ],
          remove: [
            {
              source: "amazon",
              kind: "asin",
              expectedExternalId: "B0STALE",
            },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const current = await getProductByID(ctx.db, created.entityId);
    expect(current.externalIds).toHaveLength(1);
    expect(current.externalIds[0]).toMatchObject({
      source: "amazon",
      kind: "asin",
      externalId: "B0CURRENT",
    });
  });

  it("no-ops a re-submitted external ID (no tombstone), but still replaces on a url-only change", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        externalIds: [
          {
            source: "home-depot",
            kind: "retailer_sku",
            externalId: "SKU-100",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    const allSlotRows = () =>
      getDb(ctx.db).query.productExternalId.findMany({
        where: eq(productExternalId.productId, created.entityId),
      });

    await updateProduct(
      ctx.db,
      created.entityId,
      {
        externalIds: [
          {
            source: "home-depot",
            kind: "retailer_sku",
            externalId: "SKU-100",
            url: null,
          },
        ],
      },
      ctx.actor,
    );
    const afterReimport = await allSlotRows();
    expect(afterReimport).toHaveLength(1);
    expect(afterReimport[0]).toMatchObject({
      externalId: "SKU-100",
      deletedAt: null,
    });

    await updateProduct(
      ctx.db,
      created.entityId,
      {
        externalIds: [
          {
            source: "home-depot",
            kind: "retailer_sku",
            externalId: "SKU-100",
            url: "https://www.homedepot.com/p/SKU-100",
          },
        ],
      },
      ctx.actor,
    );
    const afterUrlChange = await allSlotRows();
    const live = afterUrlChange.filter((row) => row.deletedAt === null);
    const tombstoned = afterUrlChange.filter((row) => row.deletedAt !== null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      externalId: "SKU-100",
      url: "https://www.homedepot.com/p/SKU-100",
    });
    expect(tombstoned).toHaveLength(1);
    expect(tombstoned[0]).toMatchObject({ externalId: "SKU-100", url: null });
  });

  it("skips an unchanged slot patch but still honors a remove of that same slot", async () => {
    const created = await createProduct(
      ctx.db,
      makeProductInput({
        externalIds: [
          {
            source: "home-depot",
            kind: "retailer_sku",
            externalId: "SKU-200",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );
    const slotRows = () =>
      getDb(ctx.db).query.productExternalId.findMany({
        where: eq(productExternalId.productId, created.entityId),
      });
    const before = await slotRows();
    expect(before).toHaveLength(1);
    const productBefore = await getProductByID(ctx.db, created.entityId);

    // Re-patching the identical value must leave the row completely untouched —
    // not even an `updatedAt` bump, which the unconditional onConflictDoUpdate
    // used to produce on every call.
    await patchProductExternalIds(
      ctx.db,
      created.entityId,
      {
        upsert: [
          {
            source: "home-depot",
            kind: "retailer_sku",
            externalId: "SKU-200",
            url: null,
          },
        ],
        remove: [],
      },
      ctx.actor,
    );
    const afterNoop = await slotRows();
    expect(afterNoop).toHaveLength(1);
    expect(afterNoop[0]).toMatchObject({ deletedAt: null });
    expect(afterNoop[0]?.updatedAt).toEqual(before[0]?.updatedAt);
    // The PRODUCT row's own `updatedAt` must not bump either — every upsert
    // was an unchanged-slot no-op and there were no removes, so nothing
    // actually changed.
    const productAfterNoop = await getProductByID(ctx.db, created.entityId);
    expect(productAfterNoop.updatedAt).toEqual(productBefore.updatedAt);

    await patchProductExternalIds(
      ctx.db,
      created.entityId,
      {
        upsert: [
          {
            source: "home-depot",
            kind: "retailer_sku",
            externalId: "SKU-200",
            url: null,
          },
        ],
        remove: [
          {
            source: "home-depot",
            kind: "retailer_sku",
            expectedExternalId: "SKU-200",
          },
        ],
      },
      ctx.actor,
    );
    const afterRemovePlusUpsert = await slotRows();
    const live = afterRemovePlusUpsert.filter((row) => row.deletedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ externalId: "SKU-200" });
    const productAfterRealChange = await getProductByID(
      ctx.db,
      created.entityId,
    );
    expect(productAfterRealChange.updatedAt.getTime()).toBeGreaterThan(
      productBefore.updatedAt.getTime(),
    );
  });

  it("orders identity-strength worklists deterministically", async () => {
    const weak = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Same",
        manufacturer: "generic",
        model: null,
        upc: null,
      }),
      ctx.actor,
    );
    const model = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Model",
        manufacturer: "generic",
        model: "M-1",
        upc: null,
      }),
      ctx.actor,
    );
    const external = await createProduct(
      ctx.db,
      makeProductInput({
        name: "External",
        upc: null,
        externalIds: [
          { source: "acme", kind: "item_number", externalId: "1", url: null },
        ],
      }),
      ctx.actor,
    );
    const barcode = await createProduct(
      ctx.db,
      makeProductInput({ name: "Barcode", upc: "123456789012" }),
      ctx.actor,
    );
    const first = await productList(
      ctx.db,
      {},
      [{ orderBy: "identity_strength", direction: "asc" }],
      { pageIndex: 0, pageSize: 2 },
    );
    const second = await productList(
      ctx.db,
      {},
      [{ orderBy: "identity_strength", direction: "asc" }],
      { pageIndex: 1, pageSize: 2 },
    );
    const ids = [...first.data, ...second.data].map((row) => row.id);
    expect(ids).toEqual([barcode.id, external.id, model.id, weak.id]);
  });

  it("should list products with pagination and sorting", async () => {
    const products = [
      {
        name: "Product A",
        manufacturer: "Manufacturer X",
        upc: "111111111111",
      },
      {
        name: "Product B",
        manufacturer: "Manufacturer Y",
        upc: "222222222222",
      },
      {
        name: "Product C",
        manufacturer: "Manufacturer X",
        upc: "333333333333",
      },
    ];

    for (const product of products) {
      await createProduct(ctx.db, makeProductInput(product), ctx.actor);
    }

    const firstPage = await productList(
      ctx.db,
      {},
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 2 },
    );

    expect(firstPage.data.length).toEqual(2);
    expect(firstPage.count).toEqual(3); // Total count should be 3
    expect(firstPage.data[0]!.name).toEqual("Product A");
    expect(firstPage.data[1]!.name).toEqual("Product B");

    const secondPage = await productList(
      ctx.db,
      {},
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 1, pageSize: 2 },
    );

    expect(secondPage.data.length).toEqual(1);
    expect(secondPage.count).toEqual(3);
    expect(secondPage.data[0]!.name).toEqual("Product C");

    const filteredList = await productList(
      ctx.db,
      {
        manufacturerFilter: "Manufacturer X",
      },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 10 },
    );

    expect(filteredList.data.length).toEqual(2);
    expect(filteredList.count).toEqual(2);
    expect(filteredList.data[0]!.manufacturer).toEqual("Manufacturer X");
    expect(filteredList.data[1]!.manufacturer).toEqual("Manufacturer X");

    const stacked = await productList(
      ctx.db,
      {},
      [
        { orderBy: "manufacturer", direction: "asc" },
        { orderBy: "name", direction: "desc" },
      ],
      { pageIndex: 0, pageSize: 10 },
    );
    expect(stacked.data.map((p) => p.name)).toEqual([
      "Product C",
      "Product A",
      "Product B",
    ]);
  });

  it("should update a product", async () => {
    const productData = makeProductInput({
      name: "Original Product",
      manufacturer: "Original Manufacturer",
      model: "Original-123",
      upc: "123456789012",
    });

    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    const { product: updatedProduct } = await updateProduct(
      ctx.db,
      createdProduct.entityId,
      {
        name: "Updated Product",
        manufacturer: "Updated Manufacturer",
        unitMappings: [
          {
            a: { value: 1, unit: "each" },
            b: { value: 5.99, unit: "lb" },
            source: "test",
          },
        ],
      },
      ctx.actor,
    );

    expect(updatedProduct.id).toEqual(createdProduct.id);
    expect(updatedProduct.name).toEqual("Updated Product");
    expect(updatedProduct.manufacturer).toEqual("Updated Manufacturer");
    expect(updatedProduct.model).toEqual(productData.model); // Unchanged
    expect(updatedProduct.primaryGtin).toEqual(
      productData.upc?.padStart(14, "0") ?? null,
    ); // Unchanged

    const retrievedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    expect(retrievedProduct.unitMappings.length).toEqual(1);
    expect(retrievedProduct.unitMappings[0]!.a).toEqual({
      value: 1,
      unit: "each",
    });
    expect(retrievedProduct.unitMappings[0]!.b).toEqual({
      value: 5.99,
      unit: "lb",
    });
    expect(retrievedProduct.unitMappings[0]!.source).toEqual("test");
  });

  it("should link a product to an ingredient", async () => {
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Test Ingredient", aliases: ["test", "ingredient"] },
      ctx.actor,
    );

    const productData = makeProductInput({
      name: "Test Product with Ingredient",
      model: "TEST-ING-123",
      upc: "123456789012",
      ingredientId: ingredient.id,
    });

    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    const retrievedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Test Ingredient");
  });

  it("should update ingredient association", async () => {
    const ingredient1 = await createIngredient(
      ctx.db,
      { name: "Ingredient 1", aliases: ["ing1"] },
      ctx.actor,
    );

    const ingredient2 = await createIngredient(
      ctx.db,
      { name: "Ingredient 2", aliases: ["ing2"] },
      ctx.actor,
    );

    const productData = makeProductInput({
      name: "Test Product with Ingredient",
      model: "TEST-ING-123",
      upc: "123456789012",
      ingredientId: ingredient1.id,
    });

    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    await updateProduct(
      ctx.db,
      createdProduct.entityId,
      { ingredientId: ingredient2.entityId },
      ctx.actor,
    );

    const retrievedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient2.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Ingredient 2");

    await updateProduct(
      ctx.db,
      createdProduct.entityId,
      { ingredientId: null },
      ctx.actor,
    );

    const updatedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    expect(updatedProduct.ingredient).toBeNull();
  });

  describe("presence filters", () => {
    it("finds expected-single products duplicated within one placement only", async () => {
      const first = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Duplicate placement A" }),
        ctx.actor,
      );
      const second = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Duplicate placement B" }),
        ctx.actor,
      );
      const duplicate = await createProduct(
        ctx.db,
        makeProductInput({ name: "Duplicated single", expectedQuantity: 1 }),
        ctx.actor,
      );
      const splitPlacement = await createProduct(
        ctx.db,
        makeProductInput({ name: "Shelf plus installed", expectedQuantity: 1 }),
        ctx.actor,
      );
      const expectedMany = await createProduct(
        ctx.db,
        makeProductInput({ name: "Expected multiple", expectedQuantity: 2 }),
        ctx.actor,
      );
      for (const productId of [duplicate.id, expectedMany.id]) {
        await createInventoryEntry(
          ctx.db,
          {
            productId,
            locationId: first.id,
            amount: { value: 1, unit: "each" },
          },
          ctx.actor,
        );
        await createInventoryEntry(
          ctx.db,
          {
            productId,
            locationId: second.id,
            amount: { value: 1, unit: "each" },
          },
          ctx.actor,
        );
      }
      await createInventoryEntry(
        ctx.db,
        {
          productId: splitPlacement.id,
          locationId: first.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: splitPlacement.id,
          locationId: second.id,
          amount: { value: 1, unit: "each" },
          placement: "installed",
        },
        ctx.actor,
      );

      const result = await productList(
        ctx.db,
        { inventoryMultiplicity: "duplicate_within_placement" },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 20 },
      );

      expect(result.data.map((row) => row.id)).toContain(duplicate.id);
      expect(result.data.map((row) => row.id)).not.toContain(splitPlacement.id);
      expect(result.data.map((row) => row.id)).not.toContain(expectedMany.id);
    });

    it("inventoryPresenceFilter: none returns only products with no live inventory entry", async () => {
      const location = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Presence Filter Location" }),
        ctx.actor,
      );

      const stocked = await createProduct(
        ctx.db,
        makeProductInput({ name: "Stocked Product", upc: "700000000001" }),
        ctx.actor,
      );
      const empty = await createProduct(
        ctx.db,
        makeProductInput({ name: "Empty Product", upc: "700000000002" }),
        ctx.actor,
      );

      await createInventoryEntry(
        ctx.db,
        {
          productId: stocked.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      const noneFiltered = await productList(
        ctx.db,
        {
          inventoryPresenceFilter: "none",
        },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(noneFiltered.data.map((p) => p.id)).toContain(empty.id);
      expect(noneFiltered.data.map((p) => p.id)).not.toContain(stocked.id);

      const hasFiltered = await productList(
        ctx.db,
        {
          inventoryPresenceFilter: "has",
        },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(hasFiltered.data.map((p) => p.id)).toContain(stocked.id);
      expect(hasFiltered.data.map((p) => p.id)).not.toContain(empty.id);

      const exactLocation = await productList(
        ctx.db,
        { locationIdFilter: location.id },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(exactLocation.data.map((p) => p.id)).toEqual([stocked.id]);
    });

    // The generic filter-application guard classifies a presenceFilter as
    // `skip:closed-domain`, so it only proves this field doesn't crash the
    // query builder. This is the only place the predicate itself is exercised
    // — and `check-soft-delete-filters.mjs` can't see the hoisted subquery
    // either, so it's also the only guard on its `notDeleted`.
    it("componentPresenceFilter selects kits, and 'none' means no live components", async () => {
      const kit = await createProduct(
        ctx.db,
        makeProductInput({ name: "Presence Combo Kit", upc: "700000000101" }),
        ctx.actor,
      );
      const part = await createProduct(
        ctx.db,
        makeProductInput({ name: "Presence Kit Part", upc: "700000000102" }),
        ctx.actor,
      );
      const plain = await createProduct(
        ctx.db,
        makeProductInput({ name: "Presence Plain Tool", upc: "700000000103" }),
        ctx.actor,
      );

      await attachProductComponents(
        ctx.db,
        kit.entityId,
        [{ productId: part.entityId, quantity: 2 }],
        ctx.actor,
      );

      const kits = await productList(
        ctx.db,
        { componentPresenceFilter: "has" },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 50 },
      );
      expect(kits.data.map((p) => p.id)).toContain(kit.id);
      expect(kits.data.map((p) => p.id)).not.toContain(part.id);
      expect(kits.data.map((p) => p.id)).not.toContain(plain.id);

      // `none` must return the ordinary products, not zero rows — the
      // NOT-IN-over-a-subquery shape is where that goes wrong.
      const notKits = await productList(
        ctx.db,
        { componentPresenceFilter: "none" },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 50 },
      );
      expect(notKits.data.map((p) => p.id)).toContain(plain.id);
      expect(notKits.data.map((p) => p.id)).toContain(part.id);
      expect(notKits.data.map((p) => p.id)).not.toContain(kit.id);

      const kitRow = kits.data.find((p) => p.id === kit.id);
      expect(kitRow?.componentCount).toBe(1);
      expect(notKits.data.find((p) => p.id === plain.id)?.componentCount).toBe(
        0,
      );
    });

    it("inventoryPresenceFilter: none counts a soft-deleted-only inventory entry as none", async () => {
      const location = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Soft Delete Location" }),
        ctx.actor,
      );

      const softDeletedOnly = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Soft Deleted Inventory Product",
          upc: "700000000003",
        }),
        ctx.actor,
      );

      const entry = await createInventoryEntry(
        ctx.db,
        {
          productId: softDeletedOnly.id,
          locationId: location.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      await deleteInventoryEntries(ctx.db, [entry.entityId], ctx.actor);

      const noneFiltered = await productList(
        ctx.db,
        {
          inventoryPresenceFilter: "none",
        },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(noneFiltered.data.map((p) => p.id)).toContain(softDeletedOnly.id);

      const hasFiltered = await productList(
        ctx.db,
        {
          inventoryPresenceFilter: "has",
        },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(hasFiltered.data.map((p) => p.id)).not.toContain(
        softDeletedOnly.id,
      );
    });

    it("combines stocked and missing-image filters for the enrichment worklist", async () => {
      const shelf = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Enrichment Worklist Shelf" }),
        ctx.actor,
      );
      const missingImage = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Stocked Without Image",
          upc: "700000000010",
        }),
        ctx.actor,
      );
      const pendingImage = await insertWithShortcode(ctx.db, "image", {
        key: "test-products/enrichment-cover.png",
        filename: "enrichment-cover.png",
        contentType: "image/png",
        size: 10,
        status: "UPLOADED",
      });
      const withImage = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Stocked With Image",
          upc: "700000000011",
          pendingImageIds: [parseShortcodeFor("image", pendingImage.shortcode)],
        }),
        ctx.actor,
      );
      const unstocked = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Unstocked Without Image",
          upc: "700000000012",
        }),
        ctx.actor,
      );

      for (const stocked of [missingImage, withImage]) {
        await createInventoryEntry(
          ctx.db,
          {
            productId: stocked.id,
            locationId: shelf.id,
            amount: { value: 1, unit: "each" },
          },
          ctx.actor,
        );
      }

      const worklist = await productList(
        ctx.db,
        {
          inventoryPresenceFilter: "has",
          imagePresenceFilter: "none",
        },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      const ids = worklist.data.map((p) => p.id);

      expect(ids).toContain(missingImage.id);
      expect(ids).not.toContain(withImage.id);
      expect(ids).not.toContain(unstocked.id);
    });

    it("ingredientPresenceFilter: has/none partitions products by ingredient link", async () => {
      const ingredient = await createIngredient(
        ctx.db,
        { name: "Presence Filter Ingredient", aliases: ["pfi"] },
        ctx.actor,
      );

      const linked = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Linked Product",
          upc: "700000000004",
          ingredientId: ingredient.id,
        }),
        ctx.actor,
      );
      const unlinked = await createProduct(
        ctx.db,
        makeProductInput({ name: "Unlinked Product", upc: "700000000005" }),
        ctx.actor,
      );

      const noneFiltered = await productList(
        ctx.db,
        {
          ingredientPresenceFilter: "none",
        },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(noneFiltered.data.map((p) => p.id)).toContain(unlinked.id);
      expect(noneFiltered.data.map((p) => p.id)).not.toContain(linked.id);

      const hasFiltered = await productList(
        ctx.db,
        {
          ingredientPresenceFilter: "has",
        },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(hasFiltered.data.map((p) => p.id)).toContain(linked.id);
      expect(hasFiltered.data.map((p) => p.id)).not.toContain(unlinked.id);

      const exactIngredient = await productList(
        ctx.db,
        { ingredientIdFilter: ingredient.id },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(exactIngredient.data.map((p) => p.id)).toEqual([linked.id]);
    });

    it("categoryPresenceFilter: none returns only products with a null category", async () => {
      const categorized = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Categorized Product",
          upc: "700000000006",
          category: "tools",
        }),
        ctx.actor,
      );
      const uncategorized = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Uncategorized Product",
          upc: "700000000007",
        }),
        ctx.actor,
      );

      const noneFiltered = await productList(
        ctx.db,
        {
          categoryPresenceFilter: "none",
        },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );
      expect(noneFiltered.data.map((p) => p.id)).toContain(uncategorized.id);
      expect(noneFiltered.data.map((p) => p.id)).not.toContain(categorized.id);
    });

    it("categoryFilter + categoryPresenceFilter: none is OR, not AND — returns both the selected category and the uncategorized products", async () => {
      const foodCategorized = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Food Category Product",
          upc: "700000000008",
          category: "food",
        }),
        ctx.actor,
      );
      const otherCategorized = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Other Category Product",
          upc: "700000000009",
          category: "tools",
        }),
        ctx.actor,
      );
      const uncategorized = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Uncategorized Product Two",
          upc: "700000000010",
        }),
        ctx.actor,
      );

      const filtered = await productList(
        ctx.db,
        {
          categoryFilter: ["food"],
          categoryPresenceFilter: "none",
        },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: 10 },
      );

      const ids = filtered.data.map((p) => p.id);
      expect(ids).toContain(foodCategorized.id);
      expect(ids).toContain(uncategorized.id);
      expect(ids).not.toContain(otherCategorized.id);
    });

    const listWith = (filters: ProductFilters) =>
      productList(ctx.db, filters, [{ orderBy: "name", direction: "asc" }], {
        pageIndex: 0,
        pageSize: 50,
      });

    /**
     * The mirror of location.integration.test.ts's "a shelf holding only a
     * soft-deleted product counts as empty". `productIdsWithLiveInventory`
     * inner-joins Location with notDeleted to match `dbProductToListAPI`, which
     * drops entries via `isNotDeleted(entry.location)`.
     *
     * The state is written directly because `deleteLocations` refuses a location
     * that still has live inventory (LOCATION_HAS_INVENTORY), so no repo path
     * can produce it. The join and the mapper's filter are both defensive; this
     * pins that they stay in agreement either way.
     */
    it("a product held only in a soft-deleted location counts as having no inventory", async () => {
      const shelf = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Vanishing Shelf" }),
        ctx.actor,
      );
      const stranded = await createProduct(
        ctx.db,
        makeProductInput({ name: "Stranded Product", upc: "720000000001" }),
        ctx.actor,
      );
      await createInventoryEntry(
        ctx.db,
        {
          productId: stranded.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      await getDb(ctx.db)
        .update(location)
        .set({ deletedAt: new Date() })
        .where(eq(location.id, shelf.entityId));

      const none = await listWith({ inventoryPresenceFilter: "none" });
      const row = none.data.find((p) => p.id === stranded.id);
      expect(row).toBeDefined();
      expect(row?.inventoryEntry).toEqual([]);

      const has = await listWith({ inventoryPresenceFilter: "has" });
      expect(has.data.map((p) => p.id)).not.toContain(stranded.id);
    });

    describe("expensePresenceFilter", () => {
      it("filters and sorts by server-computed expense count and net basis", async () => {
        const acquired = await createProduct(
          ctx.db,
          makeProductInput({ name: "Acquired Product", upc: "710000000030" }),
          ctx.actor,
        );
        const untouched = await createProduct(
          ctx.db,
          makeProductInput({ name: "Untouched Product", upc: "710000000031" }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Part one",
            productId: acquired.id,
            cost: 60,
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Part two",
            productId: acquired.id,
            cost: 70,
          }),
          ctx.actor,
        );

        expect(
          (await listWith({ expenseCountMin: 2 })).data.map((row) => row.id),
        ).toEqual([acquired.id]);
        expect(
          (await listWith({ expenseTotalMin: 100 })).data.map((row) => row.id),
        ).toEqual([acquired.id]);

        const sorted = await productList(
          ctx.db,
          {},
          [{ orderBy: "expenses", direction: "desc" }],
          { pageIndex: 0, pageSize: 10 },
        );
        expect(sorted.data.map((row) => row.id)).toEqual([
          acquired.id,
          untouched.id,
        ]);
      });

      /**
       * The `NOT IN (NULL)` trap, and the most important test in this file.
       * `expense.productId` is nullable, so the subquery behind this filter
       * MUST carry `isNotNull(expense.productId)`. Without it a single
       * product-less expense row anywhere in the table makes the whole
       * `notInArray` predicate UNKNOWN and `"none"` returns ZERO rows — a
       * silent, total failure that no other assertion here would catch, since
       * the unlinked expense is invisible from the product side.
       */
      it("none still returns rows when an unlinked expense exists", async () => {
        const bought = await createProduct(
          ctx.db,
          makeProductInput({ name: "Bought Product", upc: "710000000001" }),
          ctx.actor,
        );
        const neverBought = await createProduct(
          ctx.db,
          makeProductInput({ name: "Never Bought", upc: "710000000002" }),
          ctx.actor,
        );

        await createExpense(
          ctx.db,
          {
            ...makeExpenseInput(),
            name: "Linked",
            productId: bought.id,
          },
          ctx.actor,
        );
        // The poison row: a real expense with no product, which is the common
        // case in this ledger (most material runs stay unlinked).
        await createExpense(
          ctx.db,
          { ...makeExpenseInput(), name: "Unlinked", productId: null },
          ctx.actor,
        );

        const none = await listWith({ expensePresenceFilter: "none" });
        expect(none.data.map((p) => p.id)).toContain(neverBought.id);
        expect(none.data.map((p) => p.id)).not.toContain(bought.id);

        const has = await listWith({ expensePresenceFilter: "has" });
        expect(has.data.map((p) => p.id)).toContain(bought.id);
        expect(has.data.map((p) => p.id)).not.toContain(neverBought.id);
      });
    });

    describe("purchase provenance", () => {
      it("filters and sorts by linked Project and latest Purchase date", async () => {
        const { output: alphaProject } = await createProject(
          ctx.db,
          projectCreateInput.parse({ name: "Alpha Product Project" }),
          ctx.actor,
        );
        const { output: zuluProject } = await createProject(
          ctx.db,
          projectCreateInput.parse({ name: "Zulu Product Project" }),
          ctx.actor,
        );
        const alphaProduct = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Product in Alpha",
            upc: "710000000020",
          }),
          ctx.actor,
        );
        const zuluProduct = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Product in Zulu",
            upc: "710000000021",
          }),
          ctx.actor,
        );
        const unassignedProduct = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Product with no provenance",
            upc: "710000000022",
          }),
          ctx.actor,
        );

        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Older alpha purchase",
            productId: alphaProduct.id,
            projectId: alphaProject.id,
            vendor: "Alpha Store",
            date: "2026-01-10",
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Newer alpha purchase",
            productId: alphaProduct.id,
            projectId: alphaProject.id,
            vendor: "Alpha Store",
            date: "2026-03-10",
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Zulu purchase",
            productId: zuluProduct.id,
            projectId: zuluProject.id,
            vendor: "Zulu Store",
            date: "2026-02-10",
          }),
          ctx.actor,
        );

        const alphaOnly = await listWith({ projectId: alphaProject.id });
        expect(alphaOnly.data.map((row) => row.id)).toEqual([alphaProduct.id]);

        const hasProject = await listWith({ projectPresenceFilter: "has" });
        expect(new Set(hasProject.data.map((row) => row.id))).toEqual(
          new Set([alphaProduct.id, zuluProduct.id]),
        );
        const noProject = await listWith({ projectPresenceFilter: "none" });
        expect(noProject.data.map((row) => row.id)).toContain(
          unassignedProduct.id,
        );

        const byProject = await productList(
          ctx.db,
          {},
          [
            {
              orderBy: "related:product.projects",
              direction: "asc",
            },
          ],
          { pageIndex: 0, pageSize: 10 },
        );
        expect(byProject.data.map((row) => row.id)).toEqual([
          alphaProduct.id,
          zuluProduct.id,
          unassignedProduct.id,
        ]);

        const all = await listWith({});
        expect(
          all.data.find((row) => row.id === alphaProduct.id)?.purchaseDate,
        ).toBe("2026-03-10");
        expect(
          all.data.find((row) => row.id === unassignedProduct.id)?.purchaseDate,
        ).toBeNull();

        const inFebruary = await listWith({
          purchaseDateFrom: "2026-02-01",
          purchaseDateTo: "2026-02-28",
        });
        expect(inFebruary.data.map((row) => row.id)).toEqual([zuluProduct.id]);
        const noPurchaseDate = await listWith({
          purchaseDatePresenceFilter: "none",
        });
        expect(noPurchaseDate.data.map((row) => row.id)).toContain(
          unassignedProduct.id,
        );

        const byPurchaseDate = await productList(
          ctx.db,
          {},
          [{ orderBy: "purchaseDate", direction: "desc" }],
          { pageIndex: 0, pageSize: 10 },
        );
        expect(byPurchaseDate.data.map((row) => row.id)).toEqual([
          alphaProduct.id,
          zuluProduct.id,
          unassignedProduct.id,
        ]);
      });

      /**
       * The column means the latest ACQUISITION, not the latest Purchase of any
       * direction. A sale, return, or disposal is a Purchase too — modelled as
       * one whose Expenses sum negative (`repo/product/ownership.ts`) — so
       * without the acquisition predicate an eBay sale rendered as the
       * product's "purchase date" on 185 live products.
       *
       * The last case is the load-bearing one: it asserts the SORT as well as
       * the cell. The three sites (cell in `database-helpers/relations.ts`,
       * ORDER BY and both filters in `product/crud.ts`) previously agreed with
       * each other and were wrong together, which is exactly why every
       * cell-only assertion above still passed. Reverting any single site to a
       * hand-written restatement must fail here.
       */
      it("dates from acquisitions only, falling back to the expense when no Purchase exists", async () => {
        const soldOnly = await createProduct(
          ctx.db,
          makeProductInput({ name: "Exit Only Widget", upc: "710000000030" }),
          ctx.actor,
        );
        const noCounterparty = await createProduct(
          ctx.db,
          makeProductInput({ name: "Salvaged Widget", upc: "710000000031" }),
          ctx.actor,
        );
        const boughtThenSold = await createProduct(
          ctx.db,
          makeProductInput({ name: "Flipped Widget", upc: "710000000032" }),
          ctx.actor,
        );
        const control = await createProduct(
          ctx.db,
          makeProductInput({ name: "Kept Widget", upc: "710000000033" }),
          ctx.actor,
        );

        // Only ever left: a negative line against a real Purchase.
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Exit Only Widget sale",
            productId: soldOnly.id,
            vendor: "Resale Channel",
            date: "2026-06-01",
            cost: -40,
            productQuantity: -1,
          }),
          ctx.actor,
        );

        // Deliberately Purchase-less: `vendor: null` attaches no Purchase, the
        // shape of an item conveyed with the house or found/salvaged.
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Salvaged Widget — no counterparty",
            productId: noCounterparty.id,
            vendor: null,
            date: "2026-04-01",
          }),
          ctx.actor,
        );

        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Flipped Widget purchase",
            productId: boughtThenSold.id,
            vendor: "Flip Store",
            date: "2026-01-05",
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Flipped Widget sale",
            productId: boughtThenSold.id,
            vendor: "Resale Channel",
            date: "2026-05-01",
            cost: -60,
            productQuantity: -1,
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Kept Widget purchase",
            productId: control.id,
            vendor: "Flip Store",
            date: "2026-03-01",
          }),
          ctx.actor,
        );

        const cellOf = async (id: (typeof soldOnly)["id"]) => {
          const all = await listWith({});
          return all.data.find((row) => row.id === id)?.purchaseDate;
        };

        // Exit-only reads blank; the sale date is not a purchase date.
        expect(await cellOf(soldOnly.id)).toBeNull();
        // The Purchase-less acquisition dates from its own Expense.
        expect(await cellOf(noCounterparty.id)).toBe("2026-04-01");
        // A later sale does not move the acquisition date forward.
        expect(await cellOf(boughtThenSold.id)).toBe("2026-01-05");

        const presenceHas = await listWith({
          purchaseDatePresenceFilter: "has",
        });
        expect(presenceHas.data.map((row) => row.id)).not.toContain(
          soldOnly.id,
        );
        expect(presenceHas.data.map((row) => row.id)).toContain(
          noCounterparty.id,
        );
        const presenceNone = await listWith({
          purchaseDatePresenceFilter: "none",
        });
        expect(presenceNone.data.map((row) => row.id)).toContain(soldOnly.id);

        // The range filter reads the same fragment, so it sees the April
        // expense date and does NOT see either sale.
        const inApril = await listWith({
          purchaseDateFrom: "2026-04-01",
          purchaseDateTo: "2026-04-30",
        });
        expect(inApril.data.map((row) => row.id)).toContain(noCounterparty.id);
        expect(inApril.data.map((row) => row.id)).not.toContain(soldOnly.id);
        expect(inApril.data.map((row) => row.id)).not.toContain(
          boughtThenSold.id,
        );

        // The coupling assertion: sorting must rank by the same value the cell
        // shows. `boughtThenSold` (acquired 2026-01-05) sorts BELOW `control`
        // (acquired 2026-03-01) even though its latest Purchase is 2026-05-01.
        const sorted = await productList(
          ctx.db,
          { nameFilter: "Widget" },
          [{ orderBy: "purchaseDate", direction: "desc" }],
          { pageIndex: 0, pageSize: 10 },
        );
        const order = sorted.data.map((row) => row.id);
        expect(order.indexOf(noCounterparty.id)).toBeLessThan(
          order.indexOf(control.id),
        );
        expect(order.indexOf(control.id)).toBeLessThan(
          order.indexOf(boughtThenSold.id),
        );
        // Nulls last: the exit-only product sorts after every acquisition.
        expect(order.indexOf(boughtThenSold.id)).toBeLessThan(
          order.indexOf(soldOnly.id),
        );

        // The Purchases RELATION sort is a separate expression from the one
        // above, and it mirrors SQL_RELATED_VIEWS["product.purchases"], which
        // now admits acquisitions only. The generic sort guard cannot reach
        // this one — related previews come from `loadRelatedPreviews`, a
        // separate server operation, never `productList()`'s row (see
        // SORT_ONLY_FIELDS in sort-application.integration.test.ts) — so pin it
        // here. `soldOnly`'s only Purchase is its disposal, so the relation is
        // empty for it and it must sort last rather than by that sale's date.
        const byPurchaseRelation = await productList(
          ctx.db,
          { nameFilter: "Widget" },
          [{ orderBy: "related:product.purchases", direction: "desc" }],
          { pageIndex: 0, pageSize: 10 },
        );
        const relationOrder = byPurchaseRelation.data.map((row) => row.id);
        expect(relationOrder.indexOf(control.id)).toBeLessThan(
          relationOrder.indexOf(soldOnly.id),
        );
        expect(relationOrder.indexOf(boughtThenSold.id)).toBeLessThan(
          relationOrder.indexOf(soldOnly.id),
        );
      });
    });

    describe("usdaPresenceFilter", () => {
      it("matches on either key — an fdc_id or a upc to auto-match", async () => {
        const byFdcId = await createProduct(
          ctx.db,
          makeProductInput({ name: "Has Fdc", upc: null, fdc_id: 123456 }),
          ctx.actor,
        );
        const byUpc = await createProduct(
          ctx.db,
          makeProductInput({ name: "Has Upc", upc: "710000000006" }),
          ctx.actor,
        );
        const neither = await createProduct(
          ctx.db,
          makeProductInput({ name: "No Usda Key", upc: null }),
          ctx.actor,
        );

        const has = await listWith({ usdaPresenceFilter: "has" });
        const hasIds = has.data.map((p) => p.id);
        expect(hasIds).toContain(byFdcId.id);
        expect(hasIds).toContain(byUpc.id);
        expect(hasIds).not.toContain(neither.id);

        const none = await listWith({ usdaPresenceFilter: "none" });
        expect(none.data.map((p) => p.id)).toEqual([neither.id]);
      });

      it("usdaUnavailable does not clear the key", async () => {
        const flagged = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Unavailable But Keyed",
            upc: "710000000007",
            usdaUnavailable: true,
          }),
          ctx.actor,
        );

        const has = await listWith({ usdaPresenceFilter: "has" });
        expect(has.data.map((p) => p.id)).toContain(flagged.id);
      });
    });

    /**
     * `whereClause` is shared by THREE query builders — the RQB data query, the
     * unaliased `$count`, and the unaliased price-sum aggregate. Only the first
     * is exercised by the assertions above, so an alias regression in either of
     * the other two would pass every test in this file. These two check the
     * other two builders agree with the rows actually returned.
     */
    describe("all three query builders agree", () => {
      it("count matches the returned rows under a cross-entity filter", async () => {
        const mapped = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Parity Mapped",
            upc: "710000000008",
            price: 10,
            unitMappings: [
              {
                a: { value: 1, unit: "cup" },
                b: { value: 120, unit: "g" },
                source: null,
              },
            ],
          }),
          ctx.actor,
        );
        await createProduct(
          ctx.db,
          makeProductInput({
            name: "Parity Unmapped",
            upc: "710000000009",
            price: 999,
            unitMappings: [],
          }),
          ctx.actor,
        );

        const has = await listWith({ unitMappingPresenceFilter: "has" });
        expect(has.count).toEqual(has.data.length);
        expect(has.data.map((p) => p.id)).toContain(mapped.id);

        expect(has.sums.price).toEqual(
          has.data.reduce((acc, p) => acc + (p.pricing.effectivePrice ?? 0), 0),
        );
      });
    });

    describe("pricePresenceFilter", () => {
      it("derives a weighted price from known quantities and flags incomplete history", async () => {
        const derived = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Derived Price Product",
            upc: "710000000009",
            price: null,
          }),
          ctx.actor,
        );
        const shelf = await createLocation(
          ctx.db,
          makeLocationInput({ name: "Derived Price Shelf" }),
          ctx.actor,
        );
        const stocked = await createInventoryEntry(
          ctx.db,
          {
            productId: derived.id,
            locationId: shelf.id,
            amount: { value: 2, unit: "each" },
          },
          ctx.actor,
        );

        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Three pack",
            productId: derived.id,
            productQuantity: 3,
            cost: 12,
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Two pack",
            productId: derived.id,
            productQuantity: 2,
            cost: 10,
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Old receipt without a count",
            productId: derived.id,
            productQuantity: null,
            cost: 99,
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Planned purchase",
            productId: derived.id,
            productQuantity: 1,
            cost: 500,
            future: true,
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Return",
            productId: derived.id,
            productQuantity: -1,
            cost: -100,
          }),
          ctx.actor,
        );
        // A $0 discard, carrying a NEGATIVE quantity. The derived price is
        // filtered to `cost > 0` and takes `abs()` of the quantity, so this row
        // must not move `knownUnitCount` or the price — a regression here would
        // flow through `InventoryEntry.valuation` into the location rollup.
        await createExpense(
          ctx.db,
          makeExpenseInput({
            name: "Discarded — one",
            productId: derived.id,
            productQuantity: -1,
            cost: 0,
          }),
          ctx.actor,
        );

        const loaded = await getProductByID(ctx.db, derived.entityId);
        expect(loaded.pricing).toEqual({
          derivedPrice: 4.4,
          effectivePrice: 4.4,
          source: "derived",
          knownExpenseCount: 2,
          unknownExpenseCount: 1,
          knownUnitCount: 5,
          partial: true,
        });
        const valued = await getDb(ctx.db).query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, stocked.entityId),
          columns: { valuation: true },
        });
        expect(valued?.valuation).toBeCloseTo(8.8);

        const has = await listWith({ pricePresenceFilter: "has" });
        expect(has.data.map((p) => p.id)).toContain(derived.id);

        const { product: overridden } = await updateProduct(
          ctx.db,
          derived.entityId,
          { price: 8 },
          ctx.actor,
        );
        expect(overridden.pricing).toMatchObject({
          derivedPrice: 4.4,
          effectivePrice: 8,
          source: "explicit",
        });
        const overrideValuation = await getDb(
          ctx.db,
        ).query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, stocked.entityId),
          columns: { valuation: true },
        });
        expect(overrideValuation?.valuation).toBeCloseTo(16);

        const { product: resumed } = await updateProduct(
          ctx.db,
          derived.entityId,
          { price: null },
          ctx.actor,
        );
        expect(resumed.pricing).toMatchObject({
          derivedPrice: 4.4,
          effectivePrice: 4.4,
          source: "derived",
        });
        const resumedValuation = await getDb(
          ctx.db,
        ).query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, stocked.entityId),
          columns: { valuation: true },
        });
        expect(resumedValuation?.valuation).toBeCloseTo(8.8);
      });

      // Regression guard for the layered fix: before it, the ONLY thing
      // stopping a tax/shipping/fee row from carrying a productId — and
      // therefore silently distorting `loadProductPricing` /
      // `derivedProductPriceSql`'s weighted-average derivation (see the
      // pricing.unit.test.ts golden-SQL guard for that half) — was
      // `createExpense`'s app-code guard alone. This pins the DB-level
      // backstop (`Expense_lineKind_productId_check`, declared in schema.ts)
      // by inserting straight through `insertWithShortcode` — the shape a
      // bulk import or a direct DB fix could still take, bypassing the repo
      // guard. NOTE: this constraint is declared in schema.ts and exercised
      // by this integration-test template (built via `pushSchema`), but is
      // NOT YET applied to the production database — see the PR description.
      it("rejects a non-principal Expense carrying a productId at the database", async () => {
        const taxImmune = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Tax-Immune Price Product",
            upc: "710000000099",
          }),
          ctx.actor,
        );

        const write = insertWithShortcode(ctx.db, "expense", {
          name: "Sales tax on the widget order",
          cost: 900,
          date: "2024-01-15",
          lineKind: "tax",
          costType: "materials",
          trade: "other",
          future: false,
          productId: taxImmune.entityId,
          productQuantity: 5,
        });
        // Pin the specific constraint, not just any rejection — a
        // NOT_NULL/FK typo elsewhere in the insert would also throw.
        await expect(write).rejects.toMatchObject({
          cause: {
            code: "23514",
            constraint: "Expense_lineKind_productId_check",
          },
        });
      });

      it("partitions on whether price is set", async () => {
        const priced = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Priced Product",
            upc: "710000000010",
            price: 19.99,
          }),
          ctx.actor,
        );
        const unpriced = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Unpriced Product",
            upc: "710000000011",
            price: null,
          }),
          ctx.actor,
        );

        const has = await listWith({ pricePresenceFilter: "has" });
        expect(has.data.map((p) => p.id)).toContain(priced.id);
        expect(has.data.map((p) => p.id)).not.toContain(unpriced.id);

        const none = await listWith({ pricePresenceFilter: "none" });
        expect(none.data.map((p) => p.id)).toContain(unpriced.id);
        expect(none.data.map((p) => p.id)).not.toContain(priced.id);
      });

      it("a soft-deleted product with a price is excluded from either side", async () => {
        const product = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Deleted Priced Product",
            upc: "710000000012",
            price: 5,
          }),
          ctx.actor,
        );
        await deleteProducts(ctx.db, [product.entityId], ctx.actor);

        const has = await listWith({ pricePresenceFilter: "has" });
        expect(has.data.map((p) => p.id)).not.toContain(product.id);
        const none = await listWith({ pricePresenceFilter: "none" });
        expect(none.data.map((p) => p.id)).not.toContain(product.id);
      });

      it("combines with inventoryPresenceFilter: has for the valuation-gap worklist", async () => {
        const shelf = await createLocation(
          ctx.db,
          makeLocationInput({ name: "Valuation Gap Shelf" }),
          ctx.actor,
        );
        const stockedNoPrice = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Stocked Unpriced",
            upc: "710000000013",
            price: null,
          }),
          ctx.actor,
        );
        const stockedPriced = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Stocked Priced",
            upc: "710000000014",
            price: 8,
          }),
          ctx.actor,
        );
        for (const product of [stockedNoPrice, stockedPriced]) {
          await createInventoryEntry(
            ctx.db,
            {
              productId: product.id,
              locationId: shelf.id,
              amount: { value: 1, unit: "each" },
            },
            ctx.actor,
          );
        }

        const gap = await listWith({
          inventoryPresenceFilter: "has",
          pricePresenceFilter: "none",
        });
        const gapIds = gap.data.map((p) => p.id);
        expect(gapIds).toContain(stockedNoPrice.id);
        expect(gapIds).not.toContain(stockedPriced.id);
      });
    });

    describe("modelFilter", () => {
      it("matches a model number substring but not the name", async () => {
        const matching = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Impact Driver",
            upc: "710000000015",
            model: "M18 FUEL 2853-20",
          }),
          ctx.actor,
        );
        const nonMatching = await createProduct(
          ctx.db,
          makeProductInput({
            name: "2853-20 Style Driver",
            upc: "710000000016",
            model: "Other Model",
          }),
          ctx.actor,
        );

        const filtered = await listWith({ modelFilter: "2853-20" });
        const ids = filtered.data.map((p) => p.id);
        expect(ids).toContain(matching.id);
        expect(ids).not.toContain(nonMatching.id);
      });
    });

    describe("expenseTotal", () => {
      it("nets a product's positive and negative expenses", async () => {
        const product = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Netted Product",
            upc: "710000000017",
          }),
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          {
            ...makeExpenseInput(),
            name: "Acquisition",
            cost: 100,
            productId: product.id,
          },
          ctx.actor,
        );
        await createExpense(
          ctx.db,
          {
            ...makeExpenseInput(),
            name: "Refund",
            cost: -30,
            productId: product.id,
          },
          ctx.actor,
        );

        const found = await listWith({ nameFilter: "Netted Product" });
        const row = found.data.find((p) => p.id === product.id);
        expect(row).toBeDefined();
        expect(row?.expenseTotal).toEqual(70);
      });

      it("reads 0, not null, for a product with no expenses", async () => {
        const product = await createProduct(
          ctx.db,
          makeProductInput({
            name: "No Expense Product",
            upc: "710000000018",
          }),
          ctx.actor,
        );

        const found = await listWith({ nameFilter: "No Expense Product" });
        const row = found.data.find((p) => p.id === product.id);
        expect(row).toBeDefined();
        expect(row?.expenseTotal).toEqual(0);
      });

      it("excludes a soft-deleted expense from the total", async () => {
        const product = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Refunded Away Product",
            upc: "710000000019",
          }),
          ctx.actor,
        );
        const { output: live } = await createExpense(
          ctx.db,
          {
            ...makeExpenseInput(),
            name: "Live",
            cost: 50,
            productId: product.id,
          },
          ctx.actor,
        );
        const { output: deleted } = await createExpense(
          ctx.db,
          {
            ...makeExpenseInput(),
            name: "Deleted",
            cost: 999,
            productId: product.id,
          },
          ctx.actor,
        );
        await deleteExpenses(ctx.db, [deleted.id], ctx.actor);

        const found = await listWith({ nameFilter: "Refunded Away Product" });
        const row = found.data.find((p) => p.id === product.id);
        expect(row).toBeDefined();
        expect(row?.expenseTotal).toEqual(live.cost);
      });

      describe("sums.expenseTotal", () => {
        const seed = async (name: string, upc: string, costs: number[]) => {
          const created = await createProduct(
            ctx.db,
            makeProductInput({ name, upc }),
            ctx.actor,
          );
          for (const cost of costs) {
            await createExpense(
              ctx.db,
              {
                ...makeExpenseInput(),
                name: `${name} line`,
                cost,
                productId: created.id,
              },
              ctx.actor,
            );
          }
          return created;
        };

        it("nets across the filtered set, and is scoped BY the filter", async () => {
          await seed("SumScoped Alpha", "710000000031", [100, -30]);
          await seed("SumScoped Beta", "710000000032", [25]);
          await seed("SumOther Gamma", "710000000033", [9999]);

          const scoped = await listWith({ nameFilter: "SumScoped" });
          expect(scoped.data).toHaveLength(2);
          expect(scoped.sums?.expenseTotal).toEqual(95);

          expect(scoped.sums?.expenseTotal).not.toEqual(10094);
        });

        it("reads 0 over a filtered set with no expenses at all", async () => {
          await seed("SumEmpty Delta", "710000000034", []);

          const found = await listWith({ nameFilter: "SumEmpty" });
          expect(found.data).toHaveLength(1);
          expect(found.sums?.expenseTotal).toEqual(0);
        });

        it("excludes a soft-deleted expense from the total", async () => {
          const created = await seed(
            "SumDeleted Epsilon",
            "710000000035",
            [40],
          );
          const { output: doomed } = await createExpense(
            ctx.db,
            {
              ...makeExpenseInput(),
              name: "doomed",
              cost: 500,
              productId: created.id,
            },
            ctx.actor,
          );
          await deleteExpenses(ctx.db, [doomed.id], ctx.actor);

          const found = await listWith({ nameFilter: "SumDeleted" });
          expect(found.sums?.expenseTotal).toEqual(40);
        });
      });
    });
  });

  // Home Depot renders brand names in caps, so an HD import used to mint
  // `RYOBI` beside Amazon's `Ryobi` and split one brand across two picklist
  // rows — 19 variants over 60 products before the 2026-08 backfill. Creates
  // now snap to the established spelling (`resolveEstablishedManufacturer`);
  // these lock in that behavior AND its deliberate limit at the edit path.
  describe("manufacturer spelling normalization", () => {
    it("snaps a create onto the spelling already in use", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({ name: "Circular Saw", manufacturer: "Ryobi" }),
        ctx.actor,
      );

      const imported = await createProduct(
        ctx.db,
        makeProductInput({ name: "Impact Driver", manufacturer: "RYOBI" }),
        ctx.actor,
      );

      expect(imported.manufacturer).toEqual("Ryobi");
    });

    it("collapses punctuation and spacing drift, not just case", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({ name: "Wood Glue", manufacturer: "Elmer's" }),
        ctx.actor,
      );

      const imported = await createProduct(
        ctx.db,
        makeProductInput({ name: "Wood Filler", manufacturer: "ELMERS" }),
        ctx.actor,
      );

      expect(imported.manufacturer).toEqual("Elmer's");
    });

    it("follows the majority spelling, not creation order", async () => {
      // `DEWALT` is the brand's own stylization and holds two products; a
      // later title-case import must not drag the brand off it.
      for (const name of ["Drill", "Sander"]) {
        await createProduct(
          ctx.db,
          makeProductInput({ name, manufacturer: "DEWALT" }),
          ctx.actor,
        );
      }
      await createProduct(
        ctx.db,
        makeProductInput({ name: "Jigsaw", manufacturer: "Dewalt" }),
        ctx.actor,
      );

      const imported = await createProduct(
        ctx.db,
        makeProductInput({ name: "Miter Saw", manufacturer: "DeWalt" }),
        ctx.actor,
      );

      expect(imported.manufacturer).toEqual("DEWALT");
    });

    it("keeps the caller's spelling for a brand new to the ledger", async () => {
      const created = await createProduct(
        ctx.db,
        makeProductInput({ name: "Track Saw", manufacturer: "FestoolX" }),
        ctx.actor,
      );

      expect(created.manufacturer).toEqual("FestoolX");
    });

    it("normalizes quickCreateProduct too", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({ name: "Scaffold Frame", manufacturer: "MetalTech" }),
        ctx.actor,
      );

      const quick = await quickCreateProduct(
        ctx.db,
        { name: "Guardrail", manufacturer: "METALTECH" },
        ctx.actor,
      );

      expect(quick.manufacturer).toEqual("MetalTech");
    });

    it("leaves a deliberate edit alone", async () => {
      // The escape hatch: renaming a brand has to be possible, so the snap is
      // create-only and the Problems detector is the backstop for edits.
      await createProduct(
        ctx.db,
        makeProductInput({ name: "Orbital Sander", manufacturer: "Bosch" }),
        ctx.actor,
      );
      const other = await createProduct(
        ctx.db,
        makeProductInput({ name: "Hammer Drill", manufacturer: "Bosch" }),
        ctx.actor,
      );

      const { product: renamed } = await updateProduct(
        ctx.db,
        other.entityId,
        { manufacturer: "BOSCH" },
        ctx.actor,
      );

      expect(renamed.manufacturer).toEqual("BOSCH");
    });
  });

  describe("findProductByNameFuzzyManufacturer", () => {
    it("should find product by exact name and manufacturer match", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Power Drill",
          manufacturer: "DeWalt",
          model: null,
        }),
        ctx.actor,
      );

      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Power Drill",
        "DeWalt",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Power Drill");
      expect(found!.manufacturer).toEqual("DeWalt");
    });

    it("should find product when incoming manufacturer is (unspecified)", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Router Table",
          manufacturer: "Bosch",
          model: null,
        }),
        ctx.actor,
      );

      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Router Table",
        "(unspecified)",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Router Table");
      expect(found!.manufacturer).toEqual("Bosch");
    });

    it("should find product when incoming manufacturer is empty string", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Table Saw",
          manufacturer: "Makita",
          model: null,
        }),
        ctx.actor,
      );

      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Table Saw",
        "",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Table Saw");
    });

    it("should find product when incoming manufacturer is null", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Circular Saw",
          manufacturer: "Ryobi",
          model: null,
        }),
        ctx.actor,
      );

      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Circular Saw",
        null,
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Circular Saw");
    });

    it("should fallback to (unspecified) manufacturer when specific manufacturer not found", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Hammer",
          manufacturer: "(unspecified)",
          model: null,
        }),
        ctx.actor,
      );

      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Hammer",
        "Stanley",
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Hammer");
      expect(found!.manufacturer).toEqual("(unspecified)");
    });

    it("should NOT find product when both have different specific manufacturers", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Jigsaw",
          manufacturer: "DeWalt",
          model: null,
        }),
        ctx.actor,
      );

      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Jigsaw",
        "Bosch",
      );

      expect(found).toBeNull();
    });

    it("should prefer exact manufacturer match over (unspecified)", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Screwdriver",
          manufacturer: "Stanley",
          model: null,
        }),
        ctx.actor,
      );

      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Screwdriver",
          manufacturer: "(unspecified)",
          model: null,
        }),
        ctx.actor,
      );

      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Screwdriver",
        "Stanley",
      );

      expect(found).not.toBeNull();
      expect(found!.manufacturer).toEqual("Stanley");
    });

    it("should return null when product does not exist", async () => {
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Non-existent Product",
        "Any Manufacturer",
      );

      expect(found).toBeNull();
    });

    it("should be case insensitive for product name", async () => {
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Power Drill PRO",
          manufacturer: "DeWalt",
          model: null,
        }),
        ctx.actor,
      );

      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "POWER DRILL PRO",
        "dewalt", // also lowercase
      );

      expect(found).not.toBeNull();
      expect(found!.name).toEqual("Power Drill PRO");
    });
  });

  describe("deleteProducts", () => {
    /**
     * PRODUCT_HAS_EXPENSES: a live expense blocks the delete, mirroring
     * PRODUCT_HAS_INVENTORY. This used to be permitted — a product referenced
     * only by expenses deleted fine, degrading the link to a null display
     * name. That was reversed: the ledger's net cost and owned/sold window are
     * derived from these rows, and a nameless product silently corrupts that
     * derivation with no restore path.
     */
    it("rejects a product with a live expense, succeeds once the expense is soft-deleted", async () => {
      const bought = await createProduct(
        ctx.db,
        makeProductInput({ name: "Expense-Blocked Product" }),
        ctx.actor,
      );
      const { output: expense } = await createExpense(
        ctx.db,
        {
          ...makeExpenseInput(),
          name: "blocking expense",
          productId: bought.id,
        },
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [bought.entityId], ctx.actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        cause: { reason: "PRODUCT_HAS_EXPENSES" },
        message: expect.stringContaining("have expenses"),
      });

      await deleteExpenses(ctx.db, [expense.id], ctx.actor);

      await expect(
        deleteProducts(ctx.db, [bought.entityId], ctx.actor),
      ).resolves.toMatchObject({ detachedImageKeys: [] });

      await expect(
        getProductByID(ctx.db, bought.entityId),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    /**
     * PRODUCT_HAS_INVENTORY: the first and most load-bearing acquisition
     * edge — a product still sitting on a shelf can't be deleted out from
     * under its own stock.
     */
    it("rejects a product with live inventory, succeeds once the inventory is removed", async () => {
      const stocked = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Inventory-Blocked Product",
          upc: "800000000901",
        }),
        ctx.actor,
      );
      const shelf = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Inventory Block Shelf" }),
        ctx.actor,
      );
      const entry = await createInventoryEntry(
        ctx.db,
        {
          productId: stocked.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [stocked.entityId], ctx.actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        cause: { reason: "PRODUCT_HAS_INVENTORY" },
      });

      await deleteInventoryEntries(ctx.db, [entry.entityId], ctx.actor);

      await expect(
        deleteProducts(ctx.db, [stocked.entityId], ctx.actor),
      ).resolves.toMatchObject({ detachedImageKeys: [] });
    });

    it("rejects a product that is a live wish candidate, succeeds once the wish is deleted", async () => {
      const candidate = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Wish-Blocked Product",
          upc: "800000000902",
          category: "tools",
        }),
        ctx.actor,
      );
      const { output: wish } = await createWish(
        ctx.db,
        {
          name: "Wish blocking a product delete",
          notes: null,
          candidateProductIds: [candidate.id],
        },
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [candidate.entityId], ctx.actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        cause: { reason: "PRODUCT_HAS_WISH_CANDIDATES" },
      });

      await deleteWishes(ctx.db, [wish.id], ctx.actor);

      await expect(
        deleteProducts(ctx.db, [candidate.entityId], ctx.actor),
      ).resolves.toMatchObject({ detachedImageKeys: [] });
    });

    it("rejects a product used as a live task subject, then succeeds after the task is deleted", async () => {
      const furnace = await createProduct(
        ctx.db,
        makeProductInput({ name: "Task-Blocked Furnace" }),
        ctx.actor,
      );
      const { output: maintenance } = await createTask(
        ctx.db,
        taskCreateInput.parse({
          name: "Replace furnace filter",
          trade: "mechanical",
          subjectProductId: furnace.id,
        }),
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [furnace.entityId], ctx.actor),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        cause: { reason: "PRODUCT_HAS_TASKS" },
        message: expect.stringContaining("have tasks"),
      });

      await deleteTasks(ctx.db, [maintenance.id], ctx.actor);
      await expect(
        deleteProducts(ctx.db, [furnace.entityId], ctx.actor),
      ).resolves.toMatchObject({ detachedImageKeys: [] });
    });
  });

  /** Regression guard: acquisition/history edges block deletion; metadata edges cascade with required cleanup. */
  describe("PRODUCT_EDGE_ROLES backstop", () => {
    it("blocks delete while a location IS the product, and allows it once unlinked", async () => {
      // The `reference` edge retains for a reason the other blockers don't
      // share: a linked location deliberately stores NO `type` of its own, so
      // orphaning the product leaves it with no identity at all — not a
      // dangling name, an empty one.
      const prod = await createProduct(
        ctx.db,
        makeProductInput({ name: "Backstop Identity Tote" }),
        ctx.actor,
      );
      const loc = await createLocation(
        ctx.db,
        {
          name: "Backstop Identity Bin",
          aliases: [],
          productId: prod.id,
          parentId: null,
        },
        ctx.actor,
      );

      const linked = await getDb(ctx.db).query.location.findFirst({
        where: eq(location.id, loc.entityId),
      });
      expect(linked?.productId).toBe(prod.entityId);
      expect(linked?.type).toBeNull();

      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).rejects.toMatchObject({
        cause: { reason: "PRODUCT_HAS_LOCATIONS" },
      });

      await updateLocation(
        ctx.db,
        loc.entityId,
        { productId: null, type: "box" },
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).resolves.toMatchObject({ detachedImageKeys: [] });
    });

    it("counts a location that IS the product as a unit on hand", async () => {
      const prod = await createProduct(
        ctx.db,
        makeProductInput({ name: "Backstop Union Count Tote" }),
        ctx.actor,
      );
      await createLocation(
        ctx.db,
        {
          name: "Backstop Union Count Bin",
          aliases: [],
          productId: prod.id,
          parentId: null,
        },
        ctx.actor,
      );

      const ledger = (
        await loadProductQuantityLedgers(ctx.db, [prod.entityId])
      ).get(prod.entityId);
      expect(ledger?.locationCount).toBe(1);
    });

    it("blocks delete while a purchase link is live, and allows it once detached", async () => {
      const prod = await createProduct(
        ctx.db,
        makeProductInput({ name: "Backstop Purchase Link Product" }),
        ctx.actor,
      );
      const vendorId = await findOrCreateVendor(ctx.db, "Backstop Link Vendor");
      const purchaseRow = await insertWithShortcode(ctx.db, "purchase", {
        vendorId,
        date: "2026-01-05",
      });

      await attachPurchaseProducts(
        ctx.db,
        purchaseRow.id,
        [prod.entityId],
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).rejects.toMatchObject({
        cause: { reason: "PRODUCT_HAS_PURCHASE_LINKS" },
      });

      await detachPurchaseProducts(
        ctx.db,
        purchaseRow.id,
        [prod.entityId],
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).resolves.toMatchObject({ detachedImageKeys: [] });
    });

    it("allows delete — and cascade-soft-deletes — when only metadata edges (external id, unit mapping, image) are live", async () => {
      const pendingImage = await insertWithShortcode(ctx.db, "image", {
        key: "test-products/backstop-metadata.png",
        filename: "backstop-metadata.png",
        contentType: "image/png",
        size: 10,
        status: "PENDING",
      });

      const prod = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Backstop Metadata Product",
          externalIds: [
            { source: "amazon", kind: "asin", externalId: "B000BACKSTOP" },
          ],
          unitMappings: [
            {
              a: { value: 1, unit: "cup" },
              b: { value: 120, unit: "g" },
              source: null,
            },
          ],
          pendingImageIds: [parseShortcodeFor("image", pendingImage.shortcode)],
        }),
        ctx.actor,
      );

      const extIdBefore = await getDb(ctx.db).query.productExternalId.findFirst(
        {
          where: eq(productExternalId.productId, prod.entityId),
        },
      );
      const mappingBefore = await getDb(
        ctx.db,
      ).query.productUnitMappings.findFirst({
        where: eq(productUnitMappings.productId, prod.entityId),
      });
      const imageJoinBefore = await getDb(ctx.db).query.productImage.findFirst({
        where: eq(productImage.productId, prod.entityId),
      });
      expect(extIdBefore).toBeDefined();
      expect(mappingBefore).toBeDefined();
      expect(imageJoinBefore).toBeDefined();

      const imageKeyBefore = await getDb(ctx.db).query.image.findFirst({
        where: eq(image.id, pendingImage.id),
        columns: { key: true },
      });
      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).resolves.toMatchObject({
        detachedImageKeys: [imageKeyBefore!.key],
        deletedImageShortcodes: [
          parseShortcodeFor("image", pendingImage.shortcode),
        ],
      });

      const extIdAfter = await getDb(ctx.db).query.productExternalId.findFirst({
        where: eq(productExternalId.id, extIdBefore!.id),
      });
      const mappingAfter = await getDb(
        ctx.db,
      ).query.productUnitMappings.findFirst({
        where: eq(productUnitMappings.id, mappingBefore!.id),
      });
      expect(extIdAfter?.deletedAt).not.toBeNull();
      expect(mappingAfter?.deletedAt).not.toBeNull();

      // The image edge is the exception, and asserting `deletedAt` here would
      // pass vacuously on a row that no longer exists. The cascade soft-deletes
      // the join row, then the reap HARD-deletes it along with the now-orphaned
      // `Image` — leaving a tombstoned join row pointing at a deleted file
      // would strand the FK.
      expect(
        await getDb(ctx.db).query.productImage.findFirst({
          where: eq(productImage.id, imageJoinBefore!.id),
        }),
      ).toBeUndefined();
      expect(
        await getDb(ctx.db)
          .select()
          .from(image)
          .where(eq(image.id, pendingImage.id)),
      ).toHaveLength(0);
    });

    /** TODO(generic cascade backstop): keep product-specific coverage until generic fixtures model every edge shape. */
  });
});

/**
 * The detail read's answer to "where is this product" — both halves of it.
 *
 * `servingAsLocations` is embedded rather than fetched beside the product so
 * the hero's count and the table's rows cannot disagree mid-load; these pin
 * that it actually arrives, and that it counts the same live rows
 * `quantityLedger.locationCount` does.
 */
describe("product detail: where the product is", () => {
  const ctx = withTestDb();

  it("carries the locations that ARE the product", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Detail Serving Tote" }),
      ctx.actor,
    );
    const cover = await createImageFixture(ctx.db, "detail-serving-cover");
    await insertAndReturn(ctx.db, productImage, {
      productId: prod.entityId,
      imageId: cover.id,
    });
    await createLocation(
      ctx.db,
      {
        name: "detail serving bin",
        aliases: [],
        productId: prod.id,
        parentId: null,
      },
      ctx.actor,
    );

    const detail = await getProductByID(ctx.db, prod.entityId);

    expect(detail?.servingAsLocations).toHaveLength(1);
    expect(detail?.servingAsLocations[0]?.name).toBe("detail serving bin");
    expect(detail?.servingAsLocations[0]?.displayImage?.url).toBe(cover.url);
    expect(detail?.quantityLedger.locationCount).toBe(1);
    expect(detail?.inventoryEntry).toHaveLength(0);
    expect(detail?.onHandUnits).toBe(1);
  });

  it("resolves a thumbnail for every location the card names", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Detail Mark Product" }),
      ctx.actor,
    );
    const rackSku = await createProduct(
      ctx.db,
      makeProductInput({ name: "Detail Mark Rack SKU" }),
      ctx.actor,
    );
    const rackPhoto = await createImageFixture(ctx.db, "detail-mark-rack");
    await insertAndReturn(ctx.db, productImage, {
      productId: rackSku.entityId,
      imageId: rackPhoto.id,
    });

    const roomPhoto = await createImageFixture(ctx.db, "detail-mark-room");
    const room = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Detail Mark Room", type: "room" }),
      ctx.actor,
    );
    await insertAndReturn(ctx.db, locationImage, {
      locationId: room.entityId,
      imageId: roomPhoto.id,
    });
    const rack = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Detail Mark Rack",
        productId: rackSku.id,
        parentId: room.id,
      }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: prod.id,
        locationId: rack.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );

    const detail = await getProductByID(ctx.db, prod.entityId);
    const stockRow = detail?.inventoryEntry[0];

    expect(stockRow?.location.name).toBe("Detail Mark Rack");
    expect(stockRow?.location.displayImage?.url).toBe(rackPhoto.url);
    expect(
      stockRow?.location.ancestors.map((a) => [
        a.name,
        a.displayImage?.url ?? null,
      ]),
    ).toEqual([
      ["Home", null],
      ["Detail Mark Room", roomPhoto.url],
    ]);
  });

  it("hydrates root-first paths for both stock and identity locations", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Detail Path Product" }),
      ctx.actor,
    );
    const garage = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Detail Path Garage", type: "room" }),
      ctx.actor,
    );
    const area = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Detail Path Area",
        type: "area",
        parentId: garage.id,
      }),
      ctx.actor,
    );
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Detail Path Shelf",
        type: "shelf",
        parentId: area.id,
      }),
      ctx.actor,
    );
    const bin = await createLocation(
      ctx.db,
      makeLocationInput({
        name: "Detail Path Bin",
        productId: prod.id,
        parentId: shelf.id,
      }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: prod.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    const detail = await getProductByID(ctx.db, prod.entityId);

    expect(
      detail?.inventoryEntry[0]?.location.ancestors.map((node) => node.name),
    ).toEqual(["Home", "Detail Path Garage", "Detail Path Area"]);
    expect(detail?.servingAsLocations).toEqual([
      expect.objectContaining({ id: bin.id, name: "Detail Path Bin" }),
    ]);
    expect(
      detail?.servingAsLocations[0]?.ancestors.map((node) => node.name),
    ).toEqual([
      "Home",
      "Detail Path Garage",
      "Detail Path Area",
      "Detail Path Shelf",
    ]);
  });

  it("drops an entry whose LOCATION is soft-deleted, matching the list", async () => {
    const prod = await createProduct(
      ctx.db,
      makeProductInput({ name: "Detail Dead Location Product" }),
      ctx.actor,
    );
    const loc = await createLocation(
      ctx.db,
      {
        name: "detail doomed shelf",
        aliases: [],
        type: "shelf",
        parentId: null,
      },
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: prod.id,
        locationId: loc.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );

    expect(
      (await getProductByID(ctx.db, prod.entityId))?.inventoryEntry,
    ).toHaveLength(1);

    // Forced with raw SQL on purpose: `deleteLocations` refuses a location
    // that still holds inventory (LOCATION_HAS_INVENTORY), so this state is
    // unreachable through the repo. It exists in the wild anyway — a bulk
    // move, a merge, or an older code path can leave it — and the mapper's job
    // is to agree with the list when it does.
    await getDb(ctx.db).execute(
      sql`UPDATE "Location" SET "deletedAt" = now() WHERE "id" = ${loc.entityId}`,
    );

    // `dbProductToListAPI` has always filtered these and `onHandUnitsSql`
    // inner-joins live locations; the detail mapper used to be the odd one out,
    // so the same product reported different stock on two surfaces.
    const detail = await getProductByID(ctx.db, prod.entityId);
    expect(detail?.inventoryEntry).toHaveLength(0);
  });
});

describe("product repository — setProductsStockTracked", () => {
  const ctx = withTestDb();

  it("writes the tri-state over the listed ids only, auditing just the rows that changed", async () => {
    const undecided = await createProduct(
      ctx.db,
      makeProductInput({ name: "sweep undecided" }),
      ctx.actor,
    );
    const already = await createProduct(
      ctx.db,
      makeProductInput({ name: "sweep already false", stockTracked: false }),
      ctx.actor,
    );
    const bystander = await createProduct(
      ctx.db,
      makeProductInput({ name: "sweep bystander" }),
      ctx.actor,
    );

    const updated = await setProductsStockTracked(
      ctx.db,
      { ids: [undecided.id, already.id], stockTracked: false },
      ctx.actor,
    );

    expect(updated.map((row) => row.stockTracked)).toEqual([false, false]);
    expect(
      (await getProductsByShortcodes(ctx.db, [bystander.id]))[0]?.stockTracked,
    ).toBeNull();

    const entriesFor = async (id: ProductId) =>
      (
        await getAuditLog(ctx.db, {
          entityType: "product",
          entityId: id,
          limit: 50,
        })
      ).entries.filter((e) => e.action === "update");

    const changed = await entriesFor(undecided.entityId);
    expect(changed[0]?.changes?.stockTracked).toEqual({
      from: null,
      to: false,
    });
    expect(await entriesFor(already.entityId)).toHaveLength(0);
  });

  it("takes the decision back to undecided, returning the row to the worklist", async () => {
    const retired = await createProduct(
      ctx.db,
      makeProductInput({ name: "sweep undo", stockTracked: false }),
      ctx.actor,
    );

    const [restored] = await setProductsStockTracked(
      ctx.db,
      { ids: [retired.id], stockTracked: null },
      ctx.actor,
    );

    expect(restored?.stockTracked).toBeNull();
  });

  it("rejects a soft-deleted product without resurrecting it", async () => {
    const gone = await createProduct(
      ctx.db,
      makeProductInput({ name: "sweep deleted" }),
      ctx.actor,
    );
    await deleteProducts(ctx.db, [gone.entityId], ctx.actor);

    await expect(
      setProductsStockTracked(
        ctx.db,
        { ids: [gone.id], stockTracked: false },
        ctx.actor,
      ),
    ).rejects.toMatchObject({ reason: "PRODUCT_NOT_FOUND" });
  });
});

/**
 * The half-used roll: one purchase unit that is partly on the shelf and partly
 * built into the house. The model has no "consumed" quantity, so the honest
 * record is two rows in the SAME room — `stock` for the remainder, `installed`
 * for the part that went in — which the `(productId, locationId, placement)`
 * slot permits by design.
 *
 * This is the arrangement the "Consumed on projects" burn-down leans on for
 * roll and box goods, and it only reconciles because `onHandUnitsSql`
 * deliberately INCLUDES installed rows. Recording just the 0.5 remainder would
 * park the product permanently in "Shelf disagrees" instead.
 */
describe("product repository — a partly-used roll splits across placements", () => {
  const ctx = withTestDb();

  it("sums both placements to the ledger quantity, leaving no variance", async () => {
    const roll = await createProduct(
      ctx.db,
      makeProductInput({ name: "500 ft THHN Wire", category: "hardware" }),
      ctx.actor,
    );
    // One roll bought: `expectedQuantity` is 1, and the remainder must be
    // measured in the SAME unit or `onHandUnitsSql` goes NULL on mixed units.
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Wire for the rough-in",
        productId: roll.id,
        cost: 120,
        productQuantity: 1,
      }),
      ctx.actor,
    );
    const shelf = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Wire Shelf" }),
      ctx.actor,
    );

    await createInventoryEntry(
      ctx.db,
      {
        productId: roll.id,
        locationId: shelf.id,
        amount: { value: 0.5, unit: "each" },
        placement: "stock",
      },
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: roll.id,
        locationId: shelf.id,
        amount: { value: 0.5, unit: "each" },
        placement: "installed",
      },
      ctx.actor,
    );

    const ledger = (
      await loadProductQuantityLedgers(ctx.db, [roll.entityId])
    ).get(roll.entityId);
    expect(ledger?.expectedQuantity).toBe(1);

    const detail = await getProductByID(ctx.db, roll.entityId);
    expect(detail?.inventoryEntry).toHaveLength(2);
    expect(
      detail?.inventoryEntry
        .map((entry) => entry.amount.value)
        .reduce((sum, value) => sum + value, 0),
    ).toBe(1);

    const stockRows = await inventoryentryList(
      ctx.db,
      { productIdFilter: roll.id },
      [],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(stockRows.data.map((row) => row.amount.value)).toEqual([0.5]);
  });
});
