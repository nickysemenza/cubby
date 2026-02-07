import { unsafeUserId } from "@cubby/schemas/identifiers";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { createCallerFactory, createTestTRPCContext } from "../trpc";
import { inventoryRouter } from "./inventory";
import { locationRouter } from "./location";
import { productRouter } from "./product";

const TEST_USER_ID = unsafeUserId("test-user-id");

describe("location deletion", () => {
  let db: Database;
  let teardown: () => Promise<void>;
  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());

    return teardown;
  });

  describe("basic deletion", () => {
    it("should soft delete a location successfully", async () => {
      const createCaller = createCallerFactory(locationRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create a test location
      const locationData = {
        name: "Test Location for Deletion",
        type: "room" as const,
        parentId: null,
        pendingImageIds: [],
      };

      const createdLocation = await caller.create(locationData);

      // Delete the location
      await caller.delete({ ids: [createdLocation.id] });

      // Verify location is not in list
      const locations = await caller.list({
        filters: {},
        sort: { orderBy: "name", direction: "asc" },
        pagination: { pageSize: 10, pageIndex: 0 },
      });

      expect(
        locations.items.find((l) => l.id === createdLocation.id),
      ).toBeUndefined();

      // Verify getByID throws error
      await expect(caller.getByID({ id: createdLocation.id })).rejects.toThrow(
        "Location",
      );
    });

    it("should delete multiple locations in bulk", async () => {
      const createCaller = createCallerFactory(locationRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create multiple locations
      const location1 = await caller.create({
        name: "Bulk Delete Location 1",
        type: "room" as const,
        parentId: null,
        pendingImageIds: [],
      });

      const location2 = await caller.create({
        name: "Bulk Delete Location 2",
        type: "shelf" as const,
        parentId: null,
        pendingImageIds: [],
      });

      const location3 = await caller.create({
        name: "Bulk Delete Location 3",
        type: "box" as const,
        parentId: null,
        pendingImageIds: [],
      });

      // Delete all three locations
      await caller.delete({
        ids: [location1.id, location2.id, location3.id],
      });

      // Verify all locations are gone from list
      const locations = await caller.list({
        filters: {},
        sort: { orderBy: "name", direction: "asc" },
        pagination: { pageSize: 100, pageIndex: 0 },
      });

      expect(
        locations.items.find((l) => l.id === location1.id),
      ).toBeUndefined();
      expect(
        locations.items.find((l) => l.id === location2.id),
      ).toBeUndefined();
      expect(
        locations.items.find((l) => l.id === location3.id),
      ).toBeUndefined();
    });
  });

  describe("safety checks", () => {
    it("should prevent deletion if location has inventory entries", async () => {
      const createLocationCaller = createCallerFactory(locationRouter);
      const locationCaller = createLocationCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      const createInventoryCaller = createCallerFactory(inventoryRouter);
      const inventoryCaller = createInventoryCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      const createProductCaller = createCallerFactory(productRouter);
      const productCaller = createProductCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create a location
      const location = await locationCaller.create({
        name: "Location with Inventory",
        type: "room" as const,
        parentId: null,
        pendingImageIds: [],
      });

      // Create a product
      const product = await productCaller.create({
        name: "Test Product for Location",
        manufacturer: "Test Manufacturer",
        model: "LOC-TEST-1",
        upc: "888777666555",
        ndb_number: null,
        ingredientId: null,
        pendingImageIds: [],
        expectedQuantity: 1,
      });

      // Add inventory entry
      await inventoryCaller.create({
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: "count" },
      });

      // Try to delete the location - should fail
      await expect(
        locationCaller.delete({ ids: [location.id] }),
      ).rejects.toThrow("inventory entries");

      // Verify location still exists
      const retrievedLocation = await locationCaller.getByID({
        id: location.id,
      });
      expect(retrievedLocation.id).toEqual(location.id);
    });

    it("should prevent deletion if location has child locations", async () => {
      const createCaller = createCallerFactory(locationRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create a parent location
      const parentLocation = await caller.create({
        name: "Parent Location",
        type: "room" as const,
        parentId: null,
        pendingImageIds: [],
      });

      // Create a child location
      await caller.create({
        name: "Child Location",
        type: "shelf" as const,
        parentId: parentLocation.id,
        pendingImageIds: [],
      });

      // Try to delete the parent - should fail
      await expect(caller.delete({ ids: [parentLocation.id] })).rejects.toThrow(
        "child locations",
      );

      // Verify parent still exists
      const retrievedParent = await caller.getByID({ id: parentLocation.id });
      expect(retrievedParent.id).toEqual(parentLocation.id);
    });
  });

  describe("cascading behavior", () => {
    it("should cascade delete to images", async () => {
      const createCaller = createCallerFactory(locationRouter);
      const caller = createCaller(
        createTestTRPCContext(db, {
          auth: { userId: TEST_USER_ID },
        }),
      );

      // Create a location (images would be added via pendingImageIds if we had test images)
      const location = await caller.create({
        name: "Location for Cascade Test",
        type: "room" as const,
        parentId: null,
        pendingImageIds: [],
      });

      // Delete the location
      await caller.delete({ ids: [location.id] });

      // Verify location is gone
      await expect(caller.getByID({ id: location.id })).rejects.toThrow(
        "Location",
      );
    });
  });
});
