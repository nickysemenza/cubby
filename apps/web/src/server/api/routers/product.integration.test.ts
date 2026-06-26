import { NONEXISTENT_UUID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { listParams, makeProductInput } from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { productRouter } from "./product";

describe("product router", () => {
  const ctx = withTestDb();

  it("should create and retrieve a product", async () => {
    // Create a test caller for the product router
    const caller = createTestCaller(productRouter, ctx.db);

    // Create a test product
    const productData = makeProductInput({
      upc: "123456789012",
      pendingImageIds: [],
      expectedQuantity: 1,
    });

    // Create the product
    const createdProduct = await caller.create(productData);

    // Verify the product was created correctly
    expect(createdProduct.id).toBeDefined();
    expect(createdProduct.name).toEqual(productData.name);
    expect(createdProduct.manufacturer).toEqual(productData.manufacturer);
    expect(createdProduct.model).toEqual(productData.model);
    expect(createdProduct.upc).toEqual(productData.upc);

    // Retrieve the product by ID
    const retrievedProduct = await caller.getByID({ id: createdProduct.id });

    // Verify retrieved product matches created product
    expect(retrievedProduct.id).toEqual(createdProduct.id);
    expect(retrievedProduct.name).toEqual(createdProduct.name);
    expect(retrievedProduct.manufacturer).toEqual(createdProduct.manufacturer);
    expect(retrievedProduct.model).toEqual(createdProduct.model);
    expect(retrievedProduct.upc).toEqual(createdProduct.upc);
    expect(retrievedProduct.unitMappings).toEqual([]);
    expect(retrievedProduct.ingredient).toBeNull();
  });

  it("should list products with filtering", async () => {
    // Create a test caller for the product router
    const caller = createTestCaller(productRouter, ctx.db);

    // Create multiple test products
    const productData1 = makeProductInput({
      name: "Apple iPhone",
      manufacturer: "Apple",
      model: "iPhone 14",
      upc: "123456789012",
      pendingImageIds: [],
      expectedQuantity: 1,
    });

    const productData2 = makeProductInput({
      name: "Samsung Galaxy",
      manufacturer: "Samsung",
      model: "S23",
      upc: "987654321098",
      pendingImageIds: [],
      expectedQuantity: 1,
    });

    const productData3 = makeProductInput({
      name: "Apple MacBook",
      manufacturer: "Apple",
      model: "MacBook Pro",
      upc: "654321987654",
      pendingImageIds: [],
      expectedQuantity: 1,
    });

    // Create the products
    await caller.create(productData1);
    await caller.create(productData2);
    await caller.create(productData3);

    // Test listing without filters
    const allProducts = await caller.list(listParams());

    // Should return all products
    expect(allProducts.items.length).toEqual(3);
    expect(allProducts.meta.totalCount).toEqual(3);
    expect(allProducts.items.every((product) => !("food" in product))).toBe(
      true,
    );
    expect(
      allProducts.items.every((product) => !("recipeUsages" in product)),
    ).toBe(true);

    // Test filtering by name
    const appleProducts = await caller.list(
      listParams({ filters: { nameFilter: "Apple" } }),
    );

    // Should return only Apple products
    expect(appleProducts.items.length).toEqual(2);
    expect(appleProducts.meta.totalCount).toEqual(2);
    expect(appleProducts.items[0]!.name).toContain("Apple");
    expect(appleProducts.items[1]!.name).toContain("Apple");

    // Test filtering by manufacturer
    const samsungProducts = await caller.list(
      listParams({ filters: { manufacturerFilter: "Samsung" } }),
    );

    // Should return only Samsung products
    expect(samsungProducts.items.length).toEqual(1);
    expect(samsungProducts.meta.totalCount).toEqual(1);
    expect(samsungProducts.items[0]!.manufacturer).toEqual("Samsung");

    // Test filtering by UPC
    const upcProducts = await caller.list(
      listParams({ filters: { upcFilter: "123456789012" } }),
    );

    // Should return product with matching UPC
    expect(upcProducts.items.length).toEqual(1);
    expect(upcProducts.meta.totalCount).toEqual(1);
    expect(upcProducts.items[0]!.upc).toEqual("123456789012");
  });

  it("hydrates USDA food summaries separately from the list path", async () => {
    const caller = createTestCaller(productRouter, ctx.db);
    const createdProduct = await caller.create(
      makeProductInput({
        name: "Hydration Product",
        manufacturer: "Hydration Co",
        upc: "123456789012",
        pendingImageIds: [],
        expectedQuantity: 1,
      }),
    );

    const listResult = await caller.list(
      listParams({ filters: { nameFilter: "Hydration Product" } }),
    );
    expect(listResult.items).toHaveLength(1);
    expect("food" in listResult.items[0]!).toBe(false);

    const hydrated = await caller.foodSummaries({ ids: [createdProduct.id] });
    expect(hydrated).toHaveProperty(createdProduct.id);
  });

  it("should update a product", async () => {
    // Create a test caller for the product router
    const caller = createTestCaller(productRouter, ctx.db);

    // Create a test product
    const productData = makeProductInput({
      name: "Original Product",
      manufacturer: "Original Manufacturer",
      model: "Original-123",
      upc: "123456789012",
      pendingImageIds: [],
      expectedQuantity: 1,
    });

    // Create the product
    const createdProduct = await caller.create(productData);

    // Update the product
    const updatedProduct = await caller.update({
      id: createdProduct.id,
      data: {
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
    });

    // Verify the product was updated correctly
    expect(updatedProduct.id).toEqual(createdProduct.id);
    expect(updatedProduct.name).toEqual("Updated Product");
    expect(updatedProduct.manufacturer).toEqual("Updated Manufacturer");
    expect(updatedProduct.model).toEqual(productData.model); // Unchanged
    expect(updatedProduct.upc).toEqual(productData.upc); // Unchanged

    // Retrieve the product to verify unit mappings
    const retrievedProduct = await caller.getByID({ id: createdProduct.id });

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

  it("should handle partial updates correctly", async () => {
    // Create a test caller for the product router
    const caller = createTestCaller(productRouter, ctx.db);

    // Create a test product
    const productData = makeProductInput({
      upc: "123456789012",
      pendingImageIds: [],
      expectedQuantity: 1,
    });

    // Create the product
    const createdProduct = await caller.create(productData);

    // Update only the name
    const updatedProduct = await caller.update({
      id: createdProduct.id,
      data: {
        name: "Updated Name Only",
      },
    });

    // Verify only the name was updated
    expect(updatedProduct.id).toEqual(createdProduct.id);
    expect(updatedProduct.name).toEqual("Updated Name Only");
    expect(updatedProduct.manufacturer).toEqual(productData.manufacturer); // Unchanged
    expect(updatedProduct.model).toEqual(productData.model); // Unchanged
    expect(updatedProduct.upc).toEqual(productData.upc); // Unchanged
  });

  it("should throw error when retrieving product with invalid ID", async () => {
    // Create a test caller for the product router
    const caller = createTestCaller(productRouter, ctx.db);

    // Try to retrieve a product with a non-existent ID
    const nonExistentId = NONEXISTENT_UUID;

    await expect(caller.getByID({ id: nonExistentId })).rejects.toThrow();
  });

  describe("price", () => {
    it("persists the price field directly to the product (no mapping row)", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      const createdProduct = await caller.create(
        makeProductInput({
          name: "Priced Product",
          manufacturer: "Test Brand",
          model: null,
          pendingImageIds: [],
          price: 9.99,
        }),
      );

      const retrieved = await caller.getByID({ id: createdProduct.id });
      expect(retrieved.price).toBe(9.99);
      // Price is the scalar column, not a unit-mapping row.
      expect(retrieved.unitMappings).toEqual([]);
    });

    it("rejects a canonical '1 each = $X' mapping (duplicates the price field)", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      await expect(
        caller.create(
          makeProductInput({
            name: "Bad Price Mapping",
            manufacturer: "Test Brand",
            model: null,
            pendingImageIds: [],
            unitMappings: [
              {
                a: { value: 1, unit: "each" },
                b: { value: 9.99, unit: "dollar" },
                source: "manual",
              },
            ],
          }),
        ),
      ).rejects.toThrow(/Price per Item/);
    });

    it("allows a per-measure money mapping (e.g. '1 quart = $4')", async () => {
      const caller = createTestCaller(productRouter, ctx.db);

      // Generic ingredients with no discrete "each" are priced per measure; the
      // scalar column can't express that, so it stays a (costing) mapping.
      const created = await caller.create(
        makeProductInput({
          name: "Generic Buttermilk",
          manufacturer: "Test Brand",
          model: null,
          pendingImageIds: [],
          unitMappings: [
            {
              a: { value: 1, unit: "quart" },
              b: { value: 4, unit: "dollar" },
              source: "manual",
            },
          ],
        }),
      );

      const retrieved = await caller.getByID({ id: created.id });
      expect(retrieved.price).toBeNull();
      expect(retrieved.unitMappings).toHaveLength(1);
      expect(retrieved.unitMappings[0]!.b).toEqual({
        value: 4,
        unit: "dollar",
      });
    });
  });

  describe("search (lightweight picker typeahead)", () => {
    it("returns matching products without food or relation fields", async () => {
      const caller = createTestCaller(productRouter, ctx.db);
      const created = await caller.create(
        makeProductInput({
          name: "Sea Salt",
          manufacturer: "Acme",
          pendingImageIds: [],
        }),
      );

      const result = await caller.search(
        listParams({ filters: { nameFilter: "Sea Salt" } }),
      );

      const match = result.items.find((p) => p.id === created.id);
      expect(match).toBeDefined();
      expect(match?.name).toBe("Sea Salt");
      expect(match?.manufacturer).toBe("Acme");
      // The picker path returns the lean productTopLevelOut shape — no USDA food
      // (which is `list`'s long pole) and no inventory/mapping relation joins.
      expect(match && "food" in match).toBe(false);
      expect(match && "inventoryEntry" in match).toBe(false);
    });

    it("filters by name", async () => {
      const caller = createTestCaller(productRouter, ctx.db);
      await caller.create(
        makeProductInput({ name: "Olive Oil", pendingImageIds: [] }),
      );
      await caller.create(
        makeProductInput({ name: "Canola Oil", pendingImageIds: [] }),
      );

      const result = await caller.search(
        listParams({ filters: { nameFilter: "Olive" } }),
      );
      expect(result.items.length).toBe(1);
      expect(result.items[0]!.name).toBe("Olive Oil");
    });
  });
});
