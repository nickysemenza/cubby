import type { ActorContext } from "@cubby/schemas/context";
import { unsafeUserId } from "@cubby/schemas/identifiers";
import { buildTestDB, seedFromCSV } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { inventoryRouter } from "./inventory";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "ui",
};

// Keep TEST_USER_ID for tRPC context
const TEST_USER_ID = TEST_ACTOR.userId;

describe("inventory router", () => {
  let db: Database;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
    return teardown;
  });

  it("should create and retrieve an inventory entry", async () => {
    // Create a test caller for the inventory router
    const createCaller = createCallerFactory(inventoryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
      }),
    );

    // Create test location
    const location = await createLocation(
      db,
      {
        name: "Test Kitchen",
        type: "room",
        parentId: null,
      },
      TEST_ACTOR,
    );

    // Create test product
    const product = await createProduct(
      db,
      {
        name: "Test Flour",
        manufacturer: "Test Brand",
        model: "Premium Flour",
        upc: "123456789012",
        ndb_number: null,
        expectedQuantity: null,
        ingredientId: null,
        unitMappings: [],
        externalIds: [],
      },
      TEST_ACTOR,
    );

    // Create inventory entry data
    const inventoryData = {
      productId: product.id,
      locationId: location.id,
      amount: {
        value: 5,
        unit: "lbs",
      },
    };

    // Create the inventory entry
    const createdEntry = await caller.create(inventoryData);

    // Verify the inventory entry was created correctly
    expect(createdEntry.id).toBeDefined();
    expect(createdEntry.amount.value).toEqual(5);
    expect(createdEntry.amount.unit).toEqual("lbs");
    expect(createdEntry.product.name).toEqual("Test Flour");
    expect(createdEntry.location.name).toEqual("Test Kitchen");

    // Retrieve the inventory entry by ID
    const retrievedEntry = await caller.getByID({ id: createdEntry.id });

    // Verify retrieved entry matches created entry
    expect(retrievedEntry.id).toEqual(createdEntry.id);
    expect(retrievedEntry.amount.value).toEqual(5);
    expect(retrievedEntry.amount.unit).toEqual("lbs");
    expect(retrievedEntry.product.id).toEqual(product.id);
    expect(retrievedEntry.location.id).toEqual(location.id);
  });

  it("should list inventory entries with filtering", async () => {
    const createCaller = createCallerFactory(inventoryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
      }),
    );

    // Seed test data using CSV import (creates locations, products, and inventory)
    const seed = await seedFromCSV(
      db,
      [
        {
          product_name: "Flour",
          manufacturer: "Brand A",
          location_name: "Kitchen",
          quantity: 2,
          unit: "lbs",
        },
        {
          product_name: "Sugar",
          manufacturer: "Brand B",
          location_name: "Kitchen",
          quantity: 1,
          unit: "kg",
        },
        {
          product_name: "Rice",
          manufacturer: "Brand C",
          location_name: "Pantry",
          quantity: 3,
          unit: "lbs",
        },
      ],
      TEST_ACTOR,
    );

    const pantryId = seed.locationIds.get("Pantry")!;

    // Test listing without filters
    const allEntries = await caller.list({
      filters: {},
      pagination: { pageSize: 10, pageIndex: 0 },
      sort: { orderBy: "createdAt", direction: "asc" },
    });

    // Should return all entries
    expect(allEntries.items.length).toEqual(3);
    expect(allEntries.meta.totalCount).toEqual(3);

    // Test filtering by product name
    const flourEntries = await caller.list({
      filters: { productNameFilter: "Flour" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return only flour entries
    expect(flourEntries.items.length).toEqual(1);
    expect(flourEntries.meta.totalCount).toEqual(1);
    expect(flourEntries.items[0].product.name).toEqual("Flour");

    // Test filtering by location name
    const kitchenEntries = await caller.list({
      filters: { locationNameFilter: "Kitchen" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return only kitchen entries
    expect(kitchenEntries.items.length).toEqual(2);
    expect(kitchenEntries.meta.totalCount).toEqual(2);
    expect(kitchenEntries.items[0].location.name).toEqual("Kitchen");
    expect(kitchenEntries.items[1].location.name).toEqual("Kitchen");

    // Test filtering by location ID
    const pantryEntries = await caller.list({
      filters: { locationIdFilter: pantryId },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return only pantry entries
    expect(pantryEntries.items.length).toEqual(1);
    expect(pantryEntries.meta.totalCount).toEqual(1);
    expect(pantryEntries.items[0].location.id).toEqual(pantryId);

    // Test filtering with no matches
    const noMatches = await caller.list({
      filters: { productNameFilter: "Nonexistent" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return no entries
    expect(noMatches.items.length).toEqual(0);
    expect(noMatches.meta.totalCount).toEqual(0);
  });

  it("should update an inventory entry", async () => {
    const createCaller = createCallerFactory(inventoryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
      }),
    );

    // Seed initial inventory
    const seed = await seedFromCSV(
      db,
      [
        {
          product_name: "Test Product",
          manufacturer: "Test Brand",
          location_name: "Test Location",
          quantity: 2,
          unit: "pieces",
        },
      ],
      TEST_ACTOR,
    );

    const createdEntry = {
      id: seed.inventoryIds.get("Test Product@Test Location")!,
    };

    // Update the inventory entry
    const updatedEntry = await caller.update({
      id: createdEntry.id,
      data: {
        amount: {
          value: 5,
          unit: "kg",
        },
      },
    });

    // Verify the entry was updated correctly
    expect(updatedEntry.id).toEqual(createdEntry.id);
    expect(updatedEntry.amount.value).toEqual(5);
    expect(updatedEntry.amount.unit).toEqual("kg");

    // Retrieve the entry to verify changes persisted
    const retrievedEntry = await caller.getByID({ id: createdEntry.id });
    expect(retrievedEntry.amount.value).toEqual(5);
    expect(retrievedEntry.amount.unit).toEqual("kg");
  });

  it("should handle partial updates correctly", async () => {
    const createCaller = createCallerFactory(inventoryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
      }),
    );

    // Seed: Product 1 with inventory, Product 2 without (to avoid unique constraint when switching)
    const seed = await seedFromCSV(
      db,
      [
        {
          product_name: "Product 1",
          manufacturer: "Brand",
          location_name: "Location 1",
          quantity: 1,
          unit: "piece",
        },
        { product_name: "Product 2", manufacturer: "Brand" }, // product-only
      ],
      TEST_ACTOR,
    );
    // Create Location 2 separately (empty location to move to)
    const location2 = await createLocation(
      db,
      { name: "Location 2", type: "shelf", parentId: null },
      TEST_ACTOR,
    );

    const product2Id = seed.productIds.get("Product 2")!;
    const location1Id = seed.locationIds.get("Location 1")!;
    const location2Id = location2.id;
    const createdEntryId = seed.inventoryIds.get("Product 1@Location 1")!;

    // Update only the product
    const updatedEntry = await caller.update({
      id: createdEntryId,
      data: {
        productId: product2Id,
      },
    });

    // Verify only product was changed
    expect(updatedEntry.id).toEqual(createdEntryId);
    expect(updatedEntry.product.id).toEqual(product2Id);
    expect(updatedEntry.location.id).toEqual(location1Id); // Unchanged
    expect(updatedEntry.amount.value).toEqual(1); // Unchanged
    expect(updatedEntry.amount.unit).toEqual("piece"); // Unchanged

    // Update only the location
    const updatedEntry2 = await caller.update({
      id: createdEntryId,
      data: {
        locationId: location2Id,
      },
    });

    // Verify only location was changed
    expect(updatedEntry2.location.id).toEqual(location2Id);
    expect(updatedEntry2.product.id).toEqual(product2Id); // From previous update
  });

  it("should perform bulk operations correctly", async () => {
    const createCaller = createCallerFactory(inventoryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
      }),
    );

    // Seed: 3 products, one with existing inventory
    const seed = await seedFromCSV(
      db,
      [
        {
          product_name: "Bulk Product 1",
          manufacturer: "Brand",
          location_name: "Bulk Location",
          quantity: 1,
          unit: "piece",
        },
        { product_name: "Bulk Product 2", manufacturer: "Brand" }, // product-only
        { product_name: "Bulk Product 3", manufacturer: "Brand" }, // product-only
      ],
      TEST_ACTOR,
    );

    const locationId = seed.locationIds.get("Bulk Location")!;
    const product1Id = seed.productIds.get("Bulk Product 1")!;
    const product2Id = seed.productIds.get("Bulk Product 2")!;
    const product3Id = seed.productIds.get("Bulk Product 3")!;
    const existingEntryId = seed.inventoryIds.get(
      "Bulk Product 1@Bulk Location",
    )!;

    // Perform bulk operation (update existing + create new entries)
    const bulkResult = await caller.bulkProcess({
      locationId: locationId,
      items: [
        {
          id: existingEntryId, // Update existing entry
          productId: product1Id,
          locationId: locationId,
          amount: { value: 5, unit: "pieces" },
        },
        {
          // Create new entry
          productId: product2Id,
          locationId: locationId,
          amount: { value: 2, unit: "kg" },
        },
        {
          // Create another new entry
          productId: product3Id,
          locationId: locationId,
          amount: { value: 10, unit: "grams" },
        },
      ],
    });

    // Verify bulk operation results
    expect(bulkResult).toHaveLength(3);

    // Find the updated entry
    const updatedEntry = bulkResult.find(
      (entry) => entry.id === existingEntryId,
    );
    expect(updatedEntry).toBeDefined();
    expect(updatedEntry?.amount.value).toEqual(5);
    expect(updatedEntry?.amount.unit).toEqual("pieces");

    // Find the new entries
    const newEntry1 = bulkResult.find(
      (entry) => entry.product.id === product2Id,
    );
    expect(newEntry1).toBeDefined();
    expect(newEntry1?.amount.value).toEqual(2);
    expect(newEntry1?.amount.unit).toEqual("kg");

    const newEntry2 = bulkResult.find(
      (entry) => entry.product.id === product3Id,
    );
    expect(newEntry2).toBeDefined();
    expect(newEntry2?.amount.value).toEqual(10);
    expect(newEntry2?.amount.unit).toEqual("grams");

    // Verify all entries are for the correct location
    bulkResult.forEach((entry) => {
      expect(entry.location.id).toEqual(locationId);
    });
  });

  it("should throw error when retrieving inventory entry with invalid ID", async () => {
    // Create a test caller for the inventory router
    const createCaller = createCallerFactory(inventoryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
      }),
    );

    // Try to retrieve an inventory entry with a non-existent ID
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    await expect(caller.getByID({ id: nonExistentId })).rejects.toThrow(
      "Inventory entry not found",
    );
  });

  describe("bulkMove", () => {
    it("should move full quantity to a new location", async () => {
      const createCaller = createCallerFactory(inventoryRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Seed source with inventory, create empty target
      const seed = await seedFromCSV(
        db,
        [
          {
            product_name: "Move Product",
            manufacturer: "Brand",
            location_name: "Source Location",
            quantity: 10,
            unit: "pieces",
          },
        ],
        TEST_ACTOR,
      );
      const targetLocation = await createLocation(
        db,
        { name: "Target Location", type: "room", parentId: null },
        TEST_ACTOR,
      );

      const sourceLocationId = seed.locationIds.get("Source Location")!;
      const entryId = seed.inventoryIds.get("Move Product@Source Location")!;

      // Move full quantity
      const result = await caller.bulkMove({
        sourceLocationId,
        targetLocationId: targetLocation.id,
        items: [
          {
            inventoryEntryId: entryId,
            quantity: { value: 10, unit: "pieces" },
          },
        ],
      });

      expect(result).toHaveLength(1);
      expect(result[0].location.id).toEqual(targetLocation.id);
      expect(result[0].amount.value).toEqual(10);

      // Verify source location is empty
      const sourceEntries = await caller.list({
        filters: { locationIdFilter: sourceLocationId },
        pagination: { pageSize: 10, pageIndex: 0 },
      });
      expect(sourceEntries.items.length).toEqual(0);
    });

    it("should move partial quantity", async () => {
      const createCaller = createCallerFactory(inventoryRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      const seed = await seedFromCSV(
        db,
        [
          {
            product_name: "Split Product",
            manufacturer: "Brand",
            location_name: "Source",
            quantity: 10,
            unit: "kg",
          },
        ],
        TEST_ACTOR,
      );
      const targetLocation = await createLocation(
        db,
        { name: "Target", type: "room", parentId: null },
        TEST_ACTOR,
      );

      const sourceLocationId = seed.locationIds.get("Source")!;
      const entryId = seed.inventoryIds.get("Split Product@Source")!;

      // Move only 3 of 10
      const result = await caller.bulkMove({
        sourceLocationId,
        targetLocationId: targetLocation.id,
        items: [
          { inventoryEntryId: entryId, quantity: { value: 3, unit: "kg" } },
        ],
      });

      expect(result).toHaveLength(1);
      expect(result[0].amount.value).toEqual(3);
      expect(result[0].location.id).toEqual(targetLocation.id);

      // Verify source still has 7
      const sourceEntry = await caller.getByID({ id: entryId });
      expect(sourceEntry.amount.value).toEqual(7);
    });

    it("should merge with existing inventory at target", async () => {
      const createCaller = createCallerFactory(inventoryRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Same product at two locations requires direct creation
      // (seedFromCSV inventoryIds lookup doesn't support same product at multiple locations reliably)
      const sourceLocation = await createLocation(
        db,
        { name: "Source", type: "room", parentId: null },
        TEST_ACTOR,
      );
      const targetLocation = await createLocation(
        db,
        { name: "Target", type: "room", parentId: null },
        TEST_ACTOR,
      );
      const product = await createProduct(
        db,
        {
          name: "Merge Product",
          manufacturer: "Brand",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      const sourceEntry = await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: sourceLocation.id,
          amount: { value: 5, unit: "lbs" },
        },
        TEST_ACTOR,
      );

      const targetEntry = await createInventoryEntry(
        db,
        {
          productId: product.id,
          locationId: targetLocation.id,
          amount: { value: 3, unit: "lbs" },
        },
        TEST_ACTOR,
      );

      // Move full quantity from source - should merge
      const result = await caller.bulkMove({
        sourceLocationId: sourceLocation.id,
        targetLocationId: targetLocation.id,
        items: [
          {
            inventoryEntryId: sourceEntry.id,
            quantity: { value: 5, unit: "lbs" },
          },
        ],
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toEqual(targetEntry.id); // Same entry updated
      expect(result[0].amount.value).toEqual(8); // 3 + 5 = 8
    });

    it("should throw error when source and target are the same", async () => {
      const createCaller = createCallerFactory(inventoryRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      const seed = await seedFromCSV(
        db,
        [
          {
            product_name: "Error Product",
            manufacturer: "Brand",
            location_name: "Same Location",
            quantity: 5,
            unit: "units",
          },
        ],
        TEST_ACTOR,
      );

      const locationId = seed.locationIds.get("Same Location")!;
      const entryId = seed.inventoryIds.get("Error Product@Same Location")!;

      await expect(
        caller.bulkMove({
          sourceLocationId: locationId,
          targetLocationId: locationId,
          items: [
            {
              inventoryEntryId: entryId,
              quantity: { value: 5, unit: "units" },
            },
          ],
        }),
      ).rejects.toThrow("Source and target locations must be different");
    });

    it("should throw error when move quantity exceeds available", async () => {
      const createCaller = createCallerFactory(inventoryRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      const seed = await seedFromCSV(
        db,
        [
          {
            product_name: "Limited Product",
            manufacturer: "Brand",
            location_name: "Source",
            quantity: 5,
            unit: "items",
          },
        ],
        TEST_ACTOR,
      );
      const targetLocation = await createLocation(
        db,
        { name: "Target", type: "room", parentId: null },
        TEST_ACTOR,
      );

      const sourceLocationId = seed.locationIds.get("Source")!;
      const entryId = seed.inventoryIds.get("Limited Product@Source")!;

      await expect(
        caller.bulkMove({
          sourceLocationId,
          targetLocationId: targetLocation.id,
          items: [
            {
              inventoryEntryId: entryId,
              quantity: { value: 10, unit: "items" },
            },
          ], // More than available
        }),
      ).rejects.toThrow("Cannot move 10 items - only 5 available");
    });
  });

  it("should handle create and update failures gracefully", async () => {
    const createCaller = createCallerFactory(inventoryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: TEST_USER_ID },
      }),
    );

    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    // Try to create inventory entry with non-existent product
    await expect(
      caller.create({
        productId: nonExistentId,
        locationId: nonExistentId,
        amount: { value: 1, unit: "piece" },
      }),
    ).rejects.toThrow(/doesn't exist/);

    // Seed a valid entry
    const seed = await seedFromCSV(
      db,
      [
        {
          product_name: "Test Product",
          manufacturer: "Brand",
          location_name: "Test Location",
          quantity: 1,
          unit: "piece",
        },
      ],
      TEST_ACTOR,
    );
    const entryId = seed.inventoryIds.get("Test Product@Test Location")!;

    // Try to update with non-existent product
    await expect(
      caller.update({
        id: entryId,
        data: { productId: nonExistentId },
      }),
    ).rejects.toThrow(/doesn't exist/);
  });

  describe("backfillInventoryValuations", () => {
    it("should compute valuation on inventory creation when product has price", async () => {
      const createCaller = createCallerFactory(inventoryRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create location and product with price mapping
      const location = await createLocation(
        db,
        {
          name: "Pantry",
          type: "room",
          parentId: null,
        },
        TEST_ACTOR,
      );

      const product = await createProduct(
        db,
        {
          name: "Valued Product",
          manufacturer: "Brand",
          model: null,
          upc: null,
          ndb_number: null,
          expectedQuantity: null,
          ingredientId: null,
          unitMappings: [
            {
              a: { value: 1, unit: "each" },
              b: { value: 10.0, unit: "dollar" },
              source: "manual",
            },
          ],
          externalIds: [],
        },
        TEST_ACTOR,
      );

      // Create inventory via router - should compute valuation
      const entry = await caller.create({
        productId: product.id,
        locationId: location.id,
        amount: { value: 5, unit: "each" },
      });

      // Valuation should be computed: 5 units × $10 = $50
      expect(entry.valuation).toBe(50.0);
    });

    it("should return null valuation when product has no price", async () => {
      const createCaller = createCallerFactory(inventoryRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create inventory without price mapping
      const seed = await seedFromCSV(
        db,
        [
          {
            product_name: "Unpriced Product",
            manufacturer: "Brand",
            location_name: "Pantry",
            quantity: 3,
            unit: "each",
            // No price
          },
        ],
        TEST_ACTOR,
      );

      const entryId = seed.inventoryIds.get("Unpriced Product@Pantry")!;
      const entry = await caller.getByID({ id: entryId });

      // Valuation should be null
      expect(entry.valuation).toBeNull();
    });

    it("should get stale valuations count", async () => {
      const createCaller = createCallerFactory(inventoryRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create some inventory
      await seedFromCSV(
        db,
        [
          {
            product_name: "Product A",
            manufacturer: "Brand",
            location_name: "Pantry",
            quantity: 2,
            unit: "each",
          },
        ],
        TEST_ACTOR,
      );

      // Should be 0 stale since valuations are synced on creation
      const count = await caller.getStaleValuationsCount();
      expect(count).toBe(0);
    });

    it("should backfill return empty when no stale valuations", async () => {
      const createCaller = createCallerFactory(inventoryRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create inventory WITHOUT a price - valuation is null from both
      // the import and the backfill (product.price is null), so nothing is stale.
      // Note: seedFromCSV with price creates a stale valuation because it stores
      // row.price as valuation but doesn't sync product.price via unit mappings.
      await seedFromCSV(
        db,
        [
          {
            product_name: "Unpriced Product",
            manufacturer: "Brand",
            location_name: "Pantry",
            quantity: 4,
            unit: "each",
          },
        ],
        TEST_ACTOR,
      );

      // Backfill should find nothing since valuations are consistently null
      const result = await caller.backfillInventoryValuations();
      expect(result.updated).toBe(0);
      expect(result.skipped).toBeGreaterThanOrEqual(0);
    });
  });
});
