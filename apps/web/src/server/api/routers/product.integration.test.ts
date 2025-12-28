import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { type OrganizationId, unsafeUserId } from "~/schemas/identifiers";
import type { Database } from "~/server/db";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { productRouter } from "./product";

const TEST_USER_ID = unsafeUserId("test-user-id");

describe("product router", () => {
  let db: Database;
  let organizationId: OrganizationId;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, organizationId, teardown } = await buildTestDB());

    return teardown;
  });

  it("should create and retrieve a product", async () => {
    // Create a test caller for the product router
    const createCaller = createCallerFactory(productRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
        organizationId: organizationId,
      }),
    );

    // Create a test product
    const productData = {
      name: "Test Product",
      manufacturer: "Test Manufacturer",
      model: "TEST-123",
      upc: "123456789012",
      ndb_number: null,
      ingredientId: null,
      pendingImageIds: [],
      expectedQuantity: 1,
    };

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
    const createCaller = createCallerFactory(productRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
        organizationId: organizationId,
      }),
    );

    // Create multiple test products
    const productData1 = {
      name: "Apple iPhone",
      manufacturer: "Apple",
      model: "iPhone 14",
      upc: "123456789012",
      ndb_number: null,
      ingredientId: null,
      pendingImageIds: [],
      expectedQuantity: 1,
    };

    const productData2 = {
      name: "Samsung Galaxy",
      manufacturer: "Samsung",
      model: "S23",
      upc: "987654321098",
      ndb_number: null,
      ingredientId: null,
      pendingImageIds: [],
      expectedQuantity: 1,
    };

    const productData3 = {
      name: "Apple MacBook",
      manufacturer: "Apple",
      model: "MacBook Pro",
      upc: "654321987654",
      ndb_number: null,
      ingredientId: null,
      pendingImageIds: [],
      expectedQuantity: 1,
    };

    // Create the products
    await caller.create(productData1);
    await caller.create(productData2);
    await caller.create(productData3);

    // Test listing without filters
    const allProducts = await caller.list({
      filters: {},
      pagination: { pageSize: 10, pageIndex: 0 },
      sort: { orderBy: "name", direction: "asc" },
    });

    // Should return all products
    expect(allProducts.items.length).toEqual(3);
    expect(allProducts.meta.totalCount).toEqual(3);

    // Test filtering by name
    const appleProducts = await caller.list({
      filters: { nameFilter: "Apple" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return only Apple products
    expect(appleProducts.items.length).toEqual(2);
    expect(appleProducts.meta.totalCount).toEqual(2);
    expect(appleProducts.items[0].name).toContain("Apple");
    expect(appleProducts.items[1].name).toContain("Apple");

    // Test filtering by manufacturer
    const samsungProducts = await caller.list({
      filters: { manufacturerFilter: "Samsung" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return only Samsung products
    expect(samsungProducts.items.length).toEqual(1);
    expect(samsungProducts.meta.totalCount).toEqual(1);
    expect(samsungProducts.items[0].manufacturer).toEqual("Samsung");

    // Test filtering by UPC
    const upcProducts = await caller.list({
      filters: { upcFilter: "123456789012" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return product with matching UPC
    expect(upcProducts.items.length).toEqual(1);
    expect(upcProducts.meta.totalCount).toEqual(1);
    expect(upcProducts.items[0].upc).toEqual("123456789012");
  });

  it("should update a product", async () => {
    // Create a test caller for the product router
    const createCaller = createCallerFactory(productRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
        organizationId: organizationId,
      }),
    );

    // Create a test product
    const productData = {
      name: "Original Product",
      manufacturer: "Original Manufacturer",
      model: "Original-123",
      upc: "123456789012",
      ndb_number: null,
      ingredientId: null,
      pendingImageIds: [],
      expectedQuantity: 1,
    };

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
            b: { value: 5.99, unit: "dollar" },
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
    expect(retrievedProduct.unitMappings[0].a).toEqual({
      value: 1,
      unit: "each",
    });
    expect(retrievedProduct.unitMappings[0].b).toEqual({
      value: 5.99,
      unit: "dollar",
    });
    expect(retrievedProduct.unitMappings[0].source).toEqual("test");
  });

  it("should handle partial updates correctly", async () => {
    // Create a test caller for the product router
    const createCaller = createCallerFactory(productRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
        organizationId: organizationId,
      }),
    );

    // Create a test product
    const productData = {
      name: "Test Product",
      manufacturer: "Test Manufacturer",
      model: "TEST-123",
      upc: "123456789012",
      ndb_number: null,
      ingredientId: null,
      pendingImageIds: [],
      expectedQuantity: 1,
    };

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
    const createCaller = createCallerFactory(productRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
        organizationId: organizationId,
      }),
    );

    // Try to retrieve a product with a non-existent ID
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    await expect(caller.getByID({ id: nonExistentId })).rejects.toThrow();
  });

  describe("backfillProductPrices", () => {
    it("should backfill prices for products with price mappings", async () => {
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
          organizationId: organizationId,
        }),
      );

      // Create a product with a price mapping
      const productData = {
        name: "Priced Product",
        manufacturer: "Test Brand",
        model: null,
        upc: null,
        ndb_number: null,
        ingredientId: null,
        pendingImageIds: [],
        expectedQuantity: null,
        unitMappings: [
          {
            a: { value: 1, unit: "each" },
            b: { value: 9.99, unit: "dollar" },
            source: "manual",
          },
        ],
      };

      const createdProduct = await caller.create(productData);

      // The price should be synced on creation
      const retrieved = await caller.getByID({ id: createdProduct.id });
      expect(retrieved.price).toBe(9.99);

      // Now test the backfill endpoint - should return 0 since prices are synced
      const result = await caller.backfillProductPrices();
      expect(result.updated).toBe(0);
      expect(result.products).toEqual([]);
    });

    it("should return empty result when no products have stale prices", async () => {
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
          organizationId: organizationId,
        }),
      );

      // Create a product without price mappings
      const productData = {
        name: "No Price Product",
        manufacturer: "Test Brand",
        model: null,
        upc: null,
        ndb_number: null,
        ingredientId: null,
        pendingImageIds: [],
        expectedQuantity: null,
      };

      await caller.create(productData);

      // Backfill should find nothing to update
      const result = await caller.backfillProductPrices();
      expect(result.updated).toBe(0);
      expect(result.products).toEqual([]);
    });

    it("should get stale prices count", async () => {
      const createCaller = createCallerFactory(productRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
          organizationId: organizationId,
        }),
      );

      // Create a product without price mappings - no stale price
      const productData = {
        name: "Product Without Price",
        manufacturer: "Test Brand",
        model: null,
        upc: null,
        ndb_number: null,
        ingredientId: null,
        pendingImageIds: [],
        expectedQuantity: null,
      };

      await caller.create(productData);

      // Count should be 0
      const count = await caller.getStalePricesCount();
      expect(count).toBe(0);
    });
  });
});
