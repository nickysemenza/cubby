import type { ProductFilters } from "@cubby/schemas/product";
import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  image,
  inventoryEntry,
  location,
  productExternalId,
  productImage,
  productUnitMappings,
} from "~/server/db/schema";
import { PRODUCT_EDGE_ROLES } from "~/server/repo/product/edge-roles";
import { getDb, insertAndReturn } from "./database-helpers";
import { createExpense, deleteExpenses } from "./expense";
import { deleteInventoryEntries } from "./inventory";
import {
  deleteProducts,
  findProductByNameFuzzyManufacturer,
  getProductByID,
  getProductPickerItemsByIds,
  patchProductExternalIds,
  productList,
  quickCreateProduct,
  updateProduct,
} from "./product";
import { createProject } from "./project";
import {
  createIngredientFixture as createIngredient,
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";
import { insertWithShortcode } from "./shortcode-utils";
import { createTask, deleteTasks } from "./task";

describe("product repository", () => {
  const ctx = withTestDb();

  it("should create a product and retrieve it by ID", async () => {
    const productData = makeProductInput({ upc: "123456789012" });

    // Create the product
    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    // Verify the product was created correctly
    expect(createdProduct.id).toBeDefined();
    expect(createdProduct.name).toEqual(productData.name);
    expect(createdProduct.manufacturer).toEqual(productData.manufacturer);
    expect(createdProduct.model).toEqual(productData.model);
    expect(createdProduct.upc).toEqual(productData.upc);

    // Retrieve the product by ID
    const retrievedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    // Verify the retrieved product matches the created product
    expect(retrievedProduct.id).toEqual(createdProduct.id);
    expect(retrievedProduct.name).toEqual(productData.name);
    expect(retrievedProduct.manufacturer).toEqual(productData.manufacturer);
    expect(retrievedProduct.unitMappings).toEqual([]);
    expect(retrievedProduct.ingredient).toBeNull();
  });

  // Regression: this lookup was built as sql`id = ANY(${ids})`. Drizzle expands
  // a JS array in a template into a row constructor, so the query went out as
  // `= ANY(($1))` and postgres rejected it — the product combobox's semantic
  // fallback 500'd at every id count, one included.
  it("hydrates picker items by id in both single and multi-id form", async () => {
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

    const one = await getProductPickerItemsByIds(ctx.db, [first.entityId]);
    expect(one.map((item) => item.id)).toEqual([first.id]);

    const both = await getProductPickerItemsByIds(ctx.db, [
      first.entityId,
      second.entityId,
    ]);
    expect(both.map((item) => item.id)).toEqual([first.id, second.id]);
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

    // The legacy replacement endpoint remains compatible when every typed
    // entry is supplied, then the patch endpoint preserves untouched slots.
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

    // Re-importing the exact same (source, kind, externalId, url) is a no-op:
    // the write path must not soft-delete the live row and insert a copy.
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

    // A url-only change on the same slot IS a real change and must still
    // replace: one live row with the new url, one tombstone of the old.
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

    // A remove and an upsert naming the SAME slot in one call: the removal must
    // win. Without the removedSlots guard the unchanged-value check would
    // short-circuit the upsert and leave the row soft-deleted-then-untouched,
    // silently dropping the identifier the caller asked to re-add.
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
    // This call DID change something (a real remove + re-add), so this time
    // the product's `updatedAt` must advance.
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
    // Create multiple test products
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

    // Test listing with pagination - first page
    const firstPage = await productList(
      ctx.db,
      {},
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 2 },
    );

    // Should return first 2 products sorted by name ascending
    expect(firstPage.data.length).toEqual(2);
    expect(firstPage.count).toEqual(3); // Total count should be 3
    expect(firstPage.data[0]!.name).toEqual("Product A");
    expect(firstPage.data[1]!.name).toEqual("Product B");

    // Test listing with pagination - second page
    const secondPage = await productList(
      ctx.db,
      {},
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 1, pageSize: 2 },
    );

    // Should return the last product
    expect(secondPage.data.length).toEqual(1);
    expect(secondPage.count).toEqual(3);
    expect(secondPage.data[0]!.name).toEqual("Product C");

    // Test listing with filtering by manufacturer
    const filteredList = await productList(
      ctx.db,
      {
        manufacturerFilter: "Manufacturer X",
      },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 10 },
    );

    // Should return only products from Manufacturer X
    expect(filteredList.data.length).toEqual(2);
    expect(filteredList.count).toEqual(2);
    expect(filteredList.data[0]!.manufacturer).toEqual("Manufacturer X");
    expect(filteredList.data[1]!.manufacturer).toEqual("Manufacturer X");

    // Stacked multi-sort: manufacturer asc groups X before Y, name desc
    // orders within each manufacturer (C before A within X)
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

    // Create the product
    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    // Update the product
    const updatedProduct = await updateProduct(
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

    // Verify the product was updated correctly
    expect(updatedProduct.id).toEqual(createdProduct.id);
    expect(updatedProduct.name).toEqual("Updated Product");
    expect(updatedProduct.manufacturer).toEqual("Updated Manufacturer");
    expect(updatedProduct.model).toEqual(productData.model); // Unchanged
    expect(updatedProduct.upc).toEqual(productData.upc); // Unchanged

    // Retrieve the product to verify unit mappings
    const retrievedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    // Verify unit mappings were created
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
    // First create an ingredient
    const ingredient = await createIngredient(
      ctx.db,
      { name: "Test Ingredient", aliases: ["test", "ingredient"] },
      ctx.actor,
    );

    // Create a product linked to the ingredient
    const productData = makeProductInput({
      name: "Test Product with Ingredient",
      model: "TEST-ING-123",
      upc: "123456789012",
      ingredientId: ingredient.id,
    });

    // Create the product
    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    // Verify the ingredient association
    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Test Ingredient");
  });

  it("should update ingredient association", async () => {
    // Create two ingredients
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

    // Create a product linked to the first ingredient
    const productData = makeProductInput({
      name: "Test Product with Ingredient",
      model: "TEST-ING-123",
      upc: "123456789012",
      ingredientId: ingredient1.id,
    });

    // Create the product
    const createdProduct = await createProduct(ctx.db, productData, ctx.actor);

    // Update the product to link to the second ingredient
    await updateProduct(
      ctx.db,
      createdProduct.entityId,
      { ingredientId: ingredient2.entityId },
      ctx.actor,
    );

    // Retrieve the product to verify ingredient association
    const retrievedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    // Verify the ingredient association was updated
    expect(retrievedProduct.ingredient).not.toBeNull();
    expect(retrievedProduct.ingredient!.id).toEqual(ingredient2.id);
    expect(retrievedProduct.ingredient!.name).toEqual("Ingredient 2");

    // Update the product to remove ingredient association
    await updateProduct(
      ctx.db,
      createdProduct.entityId,
      { ingredientId: null },
      ctx.actor,
    );

    // Retrieve the product again
    const updatedProduct = await getProductByID(
      ctx.db,
      createdProduct.entityId,
    );

    // Verify the ingredient association was removed
    expect(updatedProduct.ingredient).toBeNull();
  });

  describe("presence filters", () => {
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
      const pendingImage = await insertAndReturn(ctx.db, image, {
        key: "test-products/enrichment-cover.png",
        url: "https://example.com/enrichment-cover.png",
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
          pendingImageIds: [pendingImage.id],
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
      // Assert BOTH halves — filter agreement alone would still pass if the
      // mapper drifted.
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

      it("a soft-deleted expense doesn't count as having one", async () => {
        const product = await createProduct(
          ctx.db,
          makeProductInput({ name: "Refunded Product", upc: "710000000003" }),
          ctx.actor,
        );
        const { output: p } = await createExpense(
          ctx.db,
          {
            ...makeExpenseInput(),
            name: "Deleted",
            productId: product.id,
          },
          ctx.actor,
        );
        await deleteExpenses(ctx.db, [p.id], ctx.actor);

        const none = await listWith({ expensePresenceFilter: "none" });
        expect(none.data.map((p) => p.id)).toContain(product.id);
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
    });

    describe("unitMappingPresenceFilter", () => {
      it("partitions on having at least one conversion edge", async () => {
        const mapped = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Mapped Product",
            upc: "710000000004",
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
        const unmapped = await createProduct(
          ctx.db,
          makeProductInput({
            name: "Unmapped Product",
            upc: "710000000005",
            unitMappings: [],
          }),
          ctx.actor,
        );

        const has = await listWith({ unitMappingPresenceFilter: "has" });
        expect(has.data.map((p) => p.id)).toContain(mapped.id);
        expect(has.data.map((p) => p.id)).not.toContain(unmapped.id);

        const none = await listWith({ unitMappingPresenceFilter: "none" });
        expect(none.data.map((p) => p.id)).toContain(unmapped.id);
        expect(none.data.map((p) => p.id)).not.toContain(mapped.id);
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

      /**
       * Pins the deliberate decision NOT to fold `usdaUnavailable` into
       * `"none"`: the flag doesn't clear the key, so the two questions stay
       * independent and both remain answerable.
       */
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

        // The footer total must cover the FILTERED set, not the whole table —
        // the 999 of the excluded product must not be in it.
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
            productQuantity: 1,
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

        const overridden = await updateProduct(
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

        const resumed = await updateProduct(
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
        await expect(write).rejects.toThrow();
        // Pin the specific constraint, not just any rejection — a
        // NOT_NULL/FK typo elsewhere in the insert would also throw.
        await write.catch((error: unknown) => {
          expect((error as { cause?: { constraint?: string } }).cause).toEqual(
            expect.objectContaining({
              code: "23514",
              constraint: "Expense_lineKind_productId_check",
            }),
          );
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

      /**
       * The valuation-gap worklist the filter exists for: products physically
       * in inventory that nobody has priced yet.
       */
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

      /**
       * The footer total behind the Net basis column.
       *
       * `createCurrencyColumn` renders `sums[column.id]` when the server
       * supplies it and otherwise reduces only the LOADED rows — so without
       * this aggregate an infinite-scrolled list would silently under-report,
       * which is the same wrong-but-plausible failure the column exists to
       * make visible.
       */
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
          // Outside the filter — its cost must not leak into the total.
          await seed("SumOther Gamma", "710000000033", [9999]);

          const scoped = await listWith({ nameFilter: "SumScoped" });
          expect(scoped.data).toHaveLength(2);
          // 100 - 30 + 25. Negative rows telescope; the total is a NET basis.
          expect(scoped.sums?.expenseTotal).toEqual(95);

          // The aggregate is computed over the where clause, not the table —
          // if it ignored the filter this would pick up the 9999.
          expect(scoped.sums?.expenseTotal).not.toEqual(10094);
        });

        it("reads 0 over a filtered set with no expenses at all", async () => {
          await seed("SumEmpty Delta", "710000000034", []);

          const found = await listWith({ nameFilter: "SumEmpty" });
          expect(found.data).toHaveLength(1);
          // `sum()` returns NULL over an empty set — coerced, not passed through.
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

      const renamed = await updateProduct(
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

      // Should find exact match
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

      // Should find product when searching with "(unspecified)" - matches by name only
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

      // Should find product when searching with empty string
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

      // Should find product when searching with null
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

      // Should find product with "(unspecified)" when searching for specific manufacturer
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

      // Should NOT find product when manufacturers are both specific and different
      const found = await findProductByNameFuzzyManufacturer(
        ctx.db,
        "Jigsaw",
        "Bosch",
      );

      expect(found).toBeNull();
    });

    it("should prefer exact manufacturer match over (unspecified)", async () => {
      // Create two products: one with specific manufacturer, one with (unspecified)
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

      // Should find exact match first
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

      // Should find with different case
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
      ).resolves.toBeUndefined();

      await expect(
        getProductByID(ctx.db, bought.entityId),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
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
      ).resolves.toBeUndefined();
    });
  });

  /**
   * Regression backstop for the completeness guarantee `PRODUCT_EDGE_ROLES`
   * (repo/product/edge-roles.ts) buys: every edge classified "acquisition" or
   * "history" must actually block `deleteProducts`, and every edge classified
   * "metadata" must NOT block it — and must itself be cascade-soft-deleted
   * once the product it's attached to is gone. A wrong classification, a
   * wrong column, or a silently-dropped predicate in either
   * `PRODUCT_RETAINING_DEPENDENTS` (product/crud.ts) or
   * `PRODUCT_RETAINING_NOT_EXISTS` (problems/detectors-product.ts) fails a
   * test here instead of shipping — declaring an edge's role only forces each
   * consumer to have *an entry* for it, not that the entry is correct.
   *
   * Scoped to `product` alone — NOT written as a fully generic "loop every
   * entity's edge-role plan" test. See the TODO at the end of this block for
   * what a future entity needs before that generalization is worth building.
   */
  describe("PRODUCT_EDGE_ROLES backstop", () => {
    it("has exactly the eight edges this test exercises (name+ordering drift is a signal to update the test too)", () => {
      expect(Object.keys(PRODUCT_EDGE_ROLES).sort()).toEqual(
        [
          "Expense.productId",
          "InventoryEntry.productId",
          "ProductExternalId.productId",
          "ProductImage.productId",
          "ProjectToolUsage.productId",
          "ProductUnitMappings.productId",
          "Task.subjectProductId",
          "WishCandidate.productId",
        ].sort(),
      );
    });

    it("blocks delete while inventory is live, and allows it once the entry is gone", async () => {
      const testLocation = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Backstop Location" }),
        ctx.actor,
      );
      const prod = await createProduct(
        ctx.db,
        makeProductInput({ name: "Backstop Inventory Product" }),
        ctx.actor,
      );
      const entry = await createInventoryEntry(
        ctx.db,
        {
          productId: prod.id,
          locationId: testLocation.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).rejects.toMatchObject({ cause: { reason: "PRODUCT_HAS_INVENTORY" } });

      await deleteInventoryEntries(ctx.db, [entry.entityId], ctx.actor);

      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).resolves.toBeUndefined();
    });

    it("blocks delete while an expense is live, and allows it once the expense is gone", async () => {
      const prod = await createProduct(
        ctx.db,
        makeProductInput({ name: "Backstop Expense Product" }),
        ctx.actor,
      );
      const { output: exp } = await createExpense(
        ctx.db,
        {
          ...makeExpenseInput(),
          name: "backstop expense",
          productId: prod.id,
        },
        ctx.actor,
      );

      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).rejects.toMatchObject({ cause: { reason: "PRODUCT_HAS_EXPENSES" } });

      await deleteExpenses(ctx.db, [exp.id], ctx.actor);

      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).resolves.toBeUndefined();
    });

    it("allows delete — and cascade-soft-deletes — when only metadata edges (external id, unit mapping, image) are live", async () => {
      const pendingImage = await insertAndReturn(ctx.db, image, {
        key: "test-products/backstop-metadata.png",
        url: "https://example.com/backstop-metadata.png",
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
          pendingImageIds: [pendingImage.id],
        }),
        ctx.actor,
      );

      // Sanity: every metadata edge is actually live before the delete —
      // otherwise a broken `createProduct` call would make the assertions
      // below vacuously pass.
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

      await expect(
        deleteProducts(ctx.db, [prod.entityId], ctx.actor),
      ).resolves.toBeUndefined();

      // Cascade: the metadata rows are soft-deleted along with the product,
      // not left live and pointing at a gone parent.
      const extIdAfter = await getDb(ctx.db).query.productExternalId.findFirst({
        where: eq(productExternalId.id, extIdBefore!.id),
      });
      const mappingAfter = await getDb(
        ctx.db,
      ).query.productUnitMappings.findFirst({
        where: eq(productUnitMappings.id, mappingBefore!.id),
      });
      const imageJoinAfter = await getDb(ctx.db).query.productImage.findFirst({
        where: eq(productImage.id, imageJoinBefore!.id),
      });
      expect(extIdAfter?.deletedAt).not.toBeNull();
      expect(mappingAfter?.deletedAt).not.toBeNull();
      expect(imageJoinAfter?.deletedAt).not.toBeNull();
    });

    // TODO(generic cascade backstop): this describe block is deliberately
    // product-only, not the fully generic "loop every entity's edge-role
    // plan, create a parent + one child per cascade edge, delete the parent,
    // assert no live children" test sketched in the ethereal-drifting-wilkes
    // plan (PR 5). Generalizing needs two things a future entity's plan must
    // supply that `product`'s doesn't uniformly share with `image`'s yet:
    //   1. A single edge-role/disposition map with a UNIFORM value shape
    //      across entities. `product`'s axis is acquisition-vs-metadata
    //      (blocks delete vs. doesn't); `image`'s IMAGE_HARD_DELETE
    //      (repo/image.ts) is deleteRow-vs-clearFk (how a child is detached).
    //      Those aren't the same boolean yet, so a generic runner can't ask
    //      "is this edge cascaded away on delete?" of both without an
    //      entity-specific branch — which defeats the point of a generic test.
    //   2. A per-edge fixture factory (create one live dependent row of that
    //      edge's shape, given a parent id). This block's own
    //      createInventoryEntry / createExpense /
    //      createProduct({unitMappings,externalIds,pendingImageIds}) calls
    //      ARE exactly that, but hand-written per entity, not a lookup table
    //      a generic runner could dispatch through.
    // Extend this block by hand for each entity that gets its own edge-role
    // map (`recipe` is next per the plan) and revisit genericizing once
    // there are three real examples to generalize from, not two.
  });
});
