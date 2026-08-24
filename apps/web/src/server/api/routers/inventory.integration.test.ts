import {
  unsafeInventoryShortcode,
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { seedFromCSV, TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  listParams,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { inventoryRouter } from "./inventory";

describe("inventory router", () => {
  const ctx = withTestDb();

  it("should create and retrieve an inventory entry", async () => {
    const caller = createTestCaller(inventoryRouter, ctx.db);

    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Test Kitchen" }),
      TEST_ACTOR,
    );

    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Test Flour",
        manufacturer: "Test Brand",
        model: "Premium Flour",
        upc: "123456789012",
      }),
      TEST_ACTOR,
    );

    const inventoryData = {
      productId: product.id,
      locationId: location.id,
      amount: {
        value: 5,
        unit: "lbs",
      },
    };

    const createdEntry = await caller.create(inventoryData);

    expect(createdEntry.id).toBeDefined();
    expect(createdEntry.amount.value).toEqual(5);
    expect(createdEntry.amount.unit).toEqual("lbs");
    expect(createdEntry.product.name).toEqual("Test Flour");
    expect(createdEntry.location.name).toEqual("Test Kitchen");

    const retrievedEntry = await caller.getByID({ id: createdEntry.id });

    expect(retrievedEntry.id).toEqual(createdEntry.id);
    expect(retrievedEntry.amount.value).toEqual(5);
    expect(retrievedEntry.amount.unit).toEqual("lbs");
    expect(retrievedEntry.product.id).toEqual(product.id);
    expect(retrievedEntry.location.id).toEqual(location.id);
  });

  it("should list inventory entries with filtering", async () => {
    const caller = createTestCaller(inventoryRouter, ctx.db);

    const seed = await seedFromCSV(
      ctx.db,
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

    const allEntries = await caller.list(listParams({ orderBy: "createdAt" }));

    expect(allEntries.items.length).toEqual(3);
    expect(allEntries.meta.totalCount).toEqual(3);

    const flourEntries = await caller.list(
      listParams({ filters: { productNameFilter: "Flour" } }),
    );

    expect(flourEntries.items.length).toEqual(1);
    expect(flourEntries.meta.totalCount).toEqual(1);
    expect(flourEntries.items[0]!.product.name).toEqual("Flour");

    const kitchenEntries = await caller.list(
      listParams({ filters: { locationNameFilter: "Kitchen" } }),
    );

    expect(kitchenEntries.items.length).toEqual(2);
    expect(kitchenEntries.meta.totalCount).toEqual(2);
    expect(kitchenEntries.items[0]!.location.name).toEqual("Kitchen");
    expect(kitchenEntries.items[1]!.location.name).toEqual("Kitchen");

    const pantryEntries = await caller.list(
      listParams({ filters: { locationIdFilter: pantryId } }),
    );

    expect(pantryEntries.items.length).toEqual(1);
    expect(pantryEntries.meta.totalCount).toEqual(1);
    expect(pantryEntries.items[0]!.location.id).toEqual(pantryId);

    const noMatches = await caller.list(
      listParams({ filters: { productNameFilter: "Nonexistent" } }),
    );

    expect(noMatches.items.length).toEqual(0);
    expect(noMatches.meta.totalCount).toEqual(0);
  });

  it("should update an inventory entry", async () => {
    const caller = createTestCaller(inventoryRouter, ctx.db);

    const seed = await seedFromCSV(
      ctx.db,
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

    const updatedEntry = await caller.update({
      id: createdEntry.id,
      data: {
        amount: {
          value: 5,
          unit: "kg",
        },
      },
    });

    expect(updatedEntry.id).toEqual(createdEntry.id);
    expect(updatedEntry.amount.value).toEqual(5);
    expect(updatedEntry.amount.unit).toEqual("kg");

    const retrievedEntry = await caller.getByID({ id: createdEntry.id });
    expect(retrievedEntry.amount.value).toEqual(5);
    expect(retrievedEntry.amount.unit).toEqual("kg");
  });

  it("should handle partial updates correctly", async () => {
    const caller = createTestCaller(inventoryRouter, ctx.db);

    // Product 2 stays unstocked so switching products cannot violate uniqueness.
    const seed = await seedFromCSV(
      ctx.db,
      [
        {
          product_name: "Product 1",
          manufacturer: "Brand",
          location_name: "Location 1",
          quantity: 1,
          unit: "piece",
        },
        { product_name: "Product 2", manufacturer: "Brand" },
      ],
      TEST_ACTOR,
    );
    const location2 = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Location 2", type: "shelf" }),
      TEST_ACTOR,
    );

    const product2Shortcode = seed.productIds.get("Product 2")!;
    const location1Shortcode = seed.locationIds.get("Location 1")!;
    const location2Id = location2.id;
    const createdEntryShortcode = seed.inventoryIds.get(
      "Product 1@Location 1",
    )!;

    const updatedEntry = await caller.update({
      id: createdEntryShortcode,
      data: {
        productId: product2Shortcode,
      },
    });

    expect(updatedEntry.id).toEqual(createdEntryShortcode);
    expect(updatedEntry.product.id).toEqual(product2Shortcode);
    expect(updatedEntry.location.id).toEqual(location1Shortcode);
    expect(updatedEntry.amount.value).toEqual(1);
    expect(updatedEntry.amount.unit).toEqual("piece");

    const updatedEntry2 = await caller.update({
      id: createdEntryShortcode,
      data: {
        locationId: location2Id,
      },
    });

    expect(updatedEntry2.location.id).toEqual(location2Id);
    expect(updatedEntry2.product.id).toEqual(product2Shortcode);
  });

  it("should perform bulk operations correctly", async () => {
    const caller = createTestCaller(inventoryRouter, ctx.db);

    const seed = await seedFromCSV(
      ctx.db,
      [
        {
          product_name: "Bulk Product 1",
          manufacturer: "Brand",
          location_name: "Bulk Location",
          quantity: 1,
          unit: "piece",
        },
        { product_name: "Bulk Product 2", manufacturer: "Brand" },
        { product_name: "Bulk Product 3", manufacturer: "Brand" },
      ],
      TEST_ACTOR,
    );

    const locationId = seed.locationIds.get("Bulk Location")!;
    const product1Shortcode = seed.productIds.get("Bulk Product 1")!;
    const product2Shortcode = seed.productIds.get("Bulk Product 2")!;
    const product3Shortcode = seed.productIds.get("Bulk Product 3")!;
    const existingEntryShortcode = seed.inventoryIds.get(
      "Bulk Product 1@Bulk Location",
    )!;

    const { items: bulkResult } = await caller.bulkProcess({
      locationId: locationId,
      items: [
        {
          id: existingEntryShortcode,
          productId: product1Shortcode,
          locationId: locationId,
          amount: { value: 5, unit: "pieces" },
        },
        {
          productId: product2Shortcode,
          locationId: locationId,
          amount: { value: 2, unit: "kg" },
        },
        {
          productId: product3Shortcode,
          locationId: locationId,
          amount: { value: 10, unit: "grams" },
        },
      ],
    });

    expect(bulkResult).toHaveLength(3);

    const updatedEntry = bulkResult.find(
      (entry) => entry.id === existingEntryShortcode,
    );
    expect(updatedEntry).toBeDefined();
    expect(updatedEntry?.amount.value).toEqual(5);
    expect(updatedEntry?.amount.unit).toEqual("pieces");

    const newEntry1 = bulkResult.find(
      (entry) => entry.product.id === product2Shortcode,
    );
    expect(newEntry1).toBeDefined();
    expect(newEntry1?.amount.value).toEqual(2);
    expect(newEntry1?.amount.unit).toEqual("kg");

    const newEntry2 = bulkResult.find(
      (entry) => entry.product.id === product3Shortcode,
    );
    expect(newEntry2).toBeDefined();
    expect(newEntry2?.amount.value).toEqual(10);
    expect(newEntry2?.amount.unit).toEqual("grams");

    bulkResult.forEach((entry) => {
      expect(entry.location.id).toEqual(locationId);
    });
  });

  it("should throw error when retrieving inventory entry with invalid ID", async () => {
    const caller = createTestCaller(inventoryRouter, ctx.db);

    const nonExistentId = unsafeInventoryShortcode("INV-ZZZZ");

    // The factory's derived `getByID` raises the same reason AND the same
    // prose as `createEntityReader`'s throwing variant — `${label} ${id} not
    // found` — so a detail route and a repo read fail identically, id included.
    await expect(caller.getByID({ id: nonExistentId })).rejects.toThrow(
      `Inventory entry ${nonExistentId} not found`,
    );
  });

  describe("bulkMove", () => {
    it("should move full quantity to a new location", async () => {
      const caller = createTestCaller(inventoryRouter, ctx.db);

      const seed = await seedFromCSV(
        ctx.db,
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
        ctx.db,
        makeLocationInput({ name: "Target Location" }),
        TEST_ACTOR,
      );

      const sourceLocationId = seed.locationIds.get("Source Location")!;
      const entryId = seed.inventoryIds.get("Move Product@Source Location")!;

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

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.location.id).toEqual(targetLocation.id);
      expect(result.items[0]!.amount.value).toEqual(10);

      const sourceEntries = await caller.list(
        listParams({ filters: { locationIdFilter: sourceLocationId } }),
      );
      expect(sourceEntries.items.length).toEqual(0);
    });

    it("should move partial quantity", async () => {
      const caller = createTestCaller(inventoryRouter, ctx.db);

      const seed = await seedFromCSV(
        ctx.db,
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
        ctx.db,
        makeLocationInput({ name: "Target" }),
        TEST_ACTOR,
      );

      const sourceLocationId = seed.locationIds.get("Source")!;
      const entryId = seed.inventoryIds.get("Split Product@Source")!;

      const result = await caller.bulkMove({
        sourceLocationId,
        targetLocationId: targetLocation.id,
        items: [
          { inventoryEntryId: entryId, quantity: { value: 3, unit: "kg" } },
        ],
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.amount.value).toEqual(3);
      expect(result.items[0]!.location.id).toEqual(targetLocation.id);

      const sourceEntry = await caller.getByID({ id: entryId });
      expect(sourceEntry.amount.value).toEqual(7);
    });

    it("should merge with existing inventory at target", async () => {
      const caller = createTestCaller(inventoryRouter, ctx.db);

      // seedFromCSV cannot reliably key the same product at multiple locations.
      const sourceLocation = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Source" }),
        TEST_ACTOR,
      );
      const targetLocation = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Target" }),
        TEST_ACTOR,
      );
      const product = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Merge Product",
          manufacturer: "Brand",
        }),
        TEST_ACTOR,
      );

      const sourceEntry = await createInventoryEntry(
        ctx.db,
        {
          productId: product.id,
          locationId: sourceLocation.id,
          amount: { value: 5, unit: "lbs" },
        },
        TEST_ACTOR,
      );

      const targetEntry = await createInventoryEntry(
        ctx.db,
        {
          productId: product.id,
          locationId: targetLocation.id,
          amount: { value: 3, unit: "lbs" },
        },
        TEST_ACTOR,
      );

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

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.id).toEqual(targetEntry.id);
      expect(result.items[0]!.amount.value).toEqual(8);
    });

    it("should throw error when move quantity exceeds available", async () => {
      const caller = createTestCaller(inventoryRouter, ctx.db);

      const seed = await seedFromCSV(
        ctx.db,
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
        ctx.db,
        makeLocationInput({ name: "Target" }),
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

    // Regression: `resolveEntityIds` used to throw on the FIRST missing code
    // (`shortcodes.find`), so a request with several bad codes hid all but
    // one. `resolveAllOrThrow`'s docstring says throw-on-first was
    // deliberately rejected, and this file's own `bulkProcess` handler
    // already lists every missing product — location/inventory codes should
    // behave the same way.
    it("lists every missing location code, not just the first", async () => {
      const caller = createTestCaller(inventoryRouter, ctx.db);

      // A real entry, so only the two location codes are unresolvable —
      // otherwise the concurrent location/inventory resolves could race and
      // surface the inventory error instead of the one under test.
      const seed = await seedFromCSV(
        ctx.db,
        [
          {
            product_name: "Missing-Location Product",
            manufacturer: "Brand",
            location_name: "Real Location",
            quantity: 5,
            unit: "items",
          },
        ],
        TEST_ACTOR,
      );
      const entryId = seed.inventoryIds.get(
        "Missing-Location Product@Real Location",
      )!;

      await expect(
        caller.bulkMove({
          sourceLocationId: unsafeLocationShortcode("LOC-ZZZZ"),
          targetLocationId: unsafeLocationShortcode("LOC-YYYY"),
          items: [
            {
              inventoryEntryId: entryId,
              quantity: { value: 1, unit: "items" },
            },
          ],
        }),
      ).rejects.toThrow(/LOC-ZZZZ.*LOC-YYYY|LOC-YYYY.*LOC-ZZZZ/);
    });
  });

  it("should handle create and update failures gracefully", async () => {
    const caller = createTestCaller(inventoryRouter, ctx.db);

    const nonExistentId = unsafeLocationShortcode("LOC-ZZZZ");
    const nonExistentProductCode = unsafeProductShortcode("PRD-ZZZZ");

    await expect(
      caller.create({
        productId: nonExistentProductCode,
        locationId: nonExistentId,
        amount: { value: 1, unit: "piece" },
      }),
    ).rejects.toThrow(/not found/);

    const seed = await seedFromCSV(
      ctx.db,
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

    await expect(
      caller.update({
        id: entryId,
        data: { productId: nonExistentProductCode },
      }),
    ).rejects.toThrow(/not found/);
  });

  describe("backfillInventoryValuations", () => {
    it("should compute valuation on inventory creation when product has price", async () => {
      const caller = createTestCaller(inventoryRouter, ctx.db);

      const location = await createLocation(
        ctx.db,
        makeLocationInput({ name: "Pantry" }),
        TEST_ACTOR,
      );

      const product = await createProduct(
        ctx.db,
        makeProductInput({
          name: "Valued Product",
          manufacturer: "Brand",
          price: 10.0,
        }),
        TEST_ACTOR,
      );

      const entry = await caller.create({
        productId: product.id,
        locationId: location.id,
        amount: { value: 5, unit: "each" },
      });

      expect(entry.valuation).toBe(50.0);
    });

    it("should return null valuation when product has no price", async () => {
      const caller = createTestCaller(inventoryRouter, ctx.db);

      const seed = await seedFromCSV(
        ctx.db,
        [
          {
            product_name: "Unpriced Product",
            manufacturer: "Brand",
            location_name: "Pantry",
            quantity: 3,
            unit: "each",
          },
        ],
        TEST_ACTOR,
      );

      const entryId = seed.inventoryIds.get("Unpriced Product@Pantry")!;
      const entry = await caller.getByID({ id: entryId });

      expect(entry.valuation).toBeNull();
    });
  });
});
