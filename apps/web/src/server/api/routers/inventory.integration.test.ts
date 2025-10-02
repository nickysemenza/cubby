import { beforeEach, describe, expect, it } from "vitest";
import { type Database } from "~/server/db";
import { buildTestDB } from "tooling/test-setup";
import { inventoryentryRouter } from "./inventory";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { type ProjectId } from "~/schemas/identifiers";

describe("inventory router", () => {
  let db: Database;
  let projectId: ProjectId;
  beforeEach(async () => {
    const { db: dbInstance, projectId: pId, teardown } = await buildTestDB();
    db = dbInstance;
    projectId = pId;

    return teardown;
  });

  it("should create and retrieve an inventory entry", async () => {
    // Create a test caller for the inventory router
    const createCaller = createCallerFactory(inventoryentryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: "test-user-id" },
        projectId: projectId,
      }),
    );

    // Create test location
    const location = await db.location.create({
      data: {
        projectId: projectId,
        name: "Test Kitchen",
        type: "room",
      },
    });

    // Create test product
    const product = await db.product.create({
      data: {
        projectId: projectId,
        name: "Test Flour",
        manufacturer: "Test Brand",
        model: "Premium Flour",
        upc: "123456789012",
      },
    });

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
    // Create a test caller for the inventory router
    const createCaller = createCallerFactory(inventoryentryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: "test-user-id" },
        projectId: projectId,
      }),
    );

    // Create test locations
    const kitchen = await db.location.create({
      data: {
        projectId: projectId,
        name: "Kitchen",
        type: "room",
      },
    });

    const pantry = await db.location.create({
      data: {
        projectId: projectId,
        name: "Pantry",
        type: "room",
      },
    });

    // Create test products
    const flour = await db.product.create({
      data: {
        projectId: projectId,
        name: "Flour",
        manufacturer: "Brand A",
        model: "All Purpose",
        upc: "111111111111",
      },
    });

    const sugar = await db.product.create({
      data: {
        projectId: projectId,
        name: "Sugar",
        manufacturer: "Brand B",
        model: "White Sugar",
        upc: "222222222222",
      },
    });

    const rice = await db.product.create({
      data: {
        projectId: projectId,
        name: "Rice",
        manufacturer: "Brand C",
        model: "Basmati Rice",
        upc: "333333333333",
      },
    });

    // Create multiple inventory entries
    await caller.create({
      productId: flour.id,
      locationId: kitchen.id,
      amount: { value: 2, unit: "lbs" },
    });

    await caller.create({
      productId: sugar.id,
      locationId: kitchen.id,
      amount: { value: 1, unit: "kg" },
    });

    await caller.create({
      productId: rice.id,
      locationId: pantry.id,
      amount: { value: 3, unit: "lbs" },
    });

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
      filters: { locationIdFilter: pantry.id },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return only pantry entries
    expect(pantryEntries.items.length).toEqual(1);
    expect(pantryEntries.meta.totalCount).toEqual(1);
    expect(pantryEntries.items[0].location.id).toEqual(pantry.id);

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
    // Create a test caller for the inventory router
    const createCaller = createCallerFactory(inventoryentryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: "test-user-id" },
        projectId: projectId,
      }),
    );

    // Create test location and product
    const location = await db.location.create({
      data: {
        projectId: projectId,
        name: "Test Location",
        type: "room",
      },
    });

    const product = await db.product.create({
      data: {
        projectId: projectId,
        name: "Test Product",
        manufacturer: "Test Brand",
        model: "Test Model",
        upc: "123456789012",
      },
    });

    // Create an inventory entry
    const inventoryData = {
      productId: product.id,
      locationId: location.id,
      amount: {
        value: 2,
        unit: "pieces",
      },
    };

    const createdEntry = await caller.create(inventoryData);

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
    // Create a test caller for the inventory router
    const createCaller = createCallerFactory(inventoryentryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: "test-user-id" },
        projectId: projectId,
      }),
    );

    // Create test location and products
    const location1 = await db.location.create({
      data: {
        projectId: projectId,
        name: "Location 1",
        type: "room",
      },
    });

    const location2 = await db.location.create({
      data: {
        projectId: projectId,
        name: "Location 2",
        type: "shelf",
      },
    });

    const product1 = await db.product.create({
      data: {
        projectId: projectId,
        name: "Product 1",
        manufacturer: "Brand",
        model: "Model 1",
        upc: "111111111111",
      },
    });

    const product2 = await db.product.create({
      data: {
        projectId: projectId,
        name: "Product 2",
        manufacturer: "Brand",
        model: "Model 2",
        upc: "222222222222",
      },
    });

    // Create an inventory entry
    const createdEntry = await caller.create({
      productId: product1.id,
      locationId: location1.id,
      amount: { value: 1, unit: "piece" },
    });

    // Update only the product
    const updatedEntry = await caller.update({
      id: createdEntry.id,
      data: {
        productId: product2.id,
      },
    });

    // Verify only product was changed
    expect(updatedEntry.id).toEqual(createdEntry.id);
    expect(updatedEntry.product.id).toEqual(product2.id);
    expect(updatedEntry.location.id).toEqual(location1.id); // Unchanged
    expect(updatedEntry.amount.value).toEqual(1); // Unchanged
    expect(updatedEntry.amount.unit).toEqual("piece"); // Unchanged

    // Update only the location
    const updatedEntry2 = await caller.update({
      id: createdEntry.id,
      data: {
        locationId: location2.id,
      },
    });

    // Verify only location was changed
    expect(updatedEntry2.location.id).toEqual(location2.id);
    expect(updatedEntry2.product.id).toEqual(product2.id); // From previous update
  });

  it("should perform bulk operations correctly", async () => {
    // Create a test caller for the inventory router
    const createCaller = createCallerFactory(inventoryentryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: "test-user-id" },
        projectId: projectId,
      }),
    );

    // Create test location
    const location = await db.location.create({
      data: {
        projectId: projectId,
        name: "Bulk Location",
        type: "room",
      },
    });

    // Create test products
    const product1 = await db.product.create({
      data: {
        projectId: projectId,
        name: "Bulk Product 1",
        manufacturer: "Brand",
        model: "Model 1",
        upc: "111111111111",
      },
    });

    const product2 = await db.product.create({
      data: {
        projectId: projectId,
        name: "Bulk Product 2",
        manufacturer: "Brand",
        model: "Model 2",
        upc: "222222222222",
      },
    });

    const product3 = await db.product.create({
      data: {
        projectId: projectId,
        name: "Bulk Product 3",
        manufacturer: "Brand",
        model: "Model 3",
        upc: "333333333333",
      },
    });

    // Create an existing entry to be updated
    const existingEntry = await caller.create({
      productId: product1.id,
      locationId: location.id,
      amount: { value: 1, unit: "piece" },
    });

    // Perform bulk operation (update existing + create new entries)
    const bulkResult = await caller.bulkProcess({
      locationId: location.id,
      items: [
        {
          id: existingEntry.id, // Update existing entry
          productId: product1.id,
          locationId: location.id,
          amount: { value: 5, unit: "pieces" },
        },
        {
          // Create new entry
          productId: product2.id,
          locationId: location.id,
          amount: { value: 2, unit: "kg" },
        },
        {
          // Create another new entry
          productId: product3.id,
          locationId: location.id,
          amount: { value: 10, unit: "grams" },
        },
      ],
    });

    // Verify bulk operation results
    expect(bulkResult).toHaveLength(3);

    // Find the updated entry
    const updatedEntry = bulkResult.find(
      (entry) => entry.id === existingEntry.id,
    );
    expect(updatedEntry).toBeDefined();
    expect(updatedEntry?.amount.value).toEqual(5);
    expect(updatedEntry?.amount.unit).toEqual("pieces");

    // Find the new entries
    const newEntry1 = bulkResult.find(
      (entry) => entry.product.id === product2.id,
    );
    expect(newEntry1).toBeDefined();
    expect(newEntry1?.amount.value).toEqual(2);
    expect(newEntry1?.amount.unit).toEqual("kg");

    const newEntry2 = bulkResult.find(
      (entry) => entry.product.id === product3.id,
    );
    expect(newEntry2).toBeDefined();
    expect(newEntry2?.amount.value).toEqual(10);
    expect(newEntry2?.amount.unit).toEqual("grams");

    // Verify all entries are for the correct location
    bulkResult.forEach((entry) => {
      expect(entry.location.id).toEqual(location.id);
    });
  });

  it("should throw error when retrieving inventory entry with invalid ID", async () => {
    // Create a test caller for the inventory router
    const createCaller = createCallerFactory(inventoryentryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: "test-user-id" },
        projectId: projectId,
      }),
    );

    // Try to retrieve an inventory entry with a non-existent ID
    const nonExistentId = "00000000-0000-0000-0000-000000000000";

    await expect(caller.getByID({ id: nonExistentId })).rejects.toThrow(
      "Inventory entry not found",
    );
  });

  it("should handle create and update failures gracefully", async () => {
    // Create a test caller for the inventory router
    const createCaller = createCallerFactory(inventoryentryRouter);
    const caller = createCaller(
      createTestTRPCContext(db, {
        auth: { userId: "test-user-id" },
        projectId: projectId,
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
    ).rejects.toThrow("Foreign key constraint violated");

    // Create a valid entry first
    const location = await db.location.create({
      data: {
        projectId: projectId,
        name: "Test Location",
        type: "room",
      },
    });

    const product = await db.product.create({
      data: {
        projectId: projectId,
        name: "Test Product",
        manufacturer: "Brand",
        model: "Model",
        upc: "123456789012",
      },
    });

    const entry = await caller.create({
      productId: product.id,
      locationId: location.id,
      amount: { value: 1, unit: "piece" },
    });

    // Try to update with non-existent product
    await expect(
      caller.update({
        id: entry.id,
        data: {
          productId: nonExistentId,
        },
      }),
    ).rejects.toThrow("Foreign key constraint violated");
  });
});
