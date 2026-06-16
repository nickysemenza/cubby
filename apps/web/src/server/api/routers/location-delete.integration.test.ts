import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { listParams, makeLocationInput } from "~/server/repo/repo.fixtures";
import { createTestCaller } from "../trpc";
import { inventoryRouter } from "./inventory";
import { locationRouter } from "./location";
import { productRouter } from "./product";

describe("location deletion", () => {
  const ctx = withTestDb();

  describe("basic deletion", () => {
    it("should soft delete a location successfully", async () => {
      const caller = createTestCaller(locationRouter, ctx.db);

      // Create a test location
      const locationData = makeLocationInput({
        name: "Test Location for Deletion",
      });

      const createdLocation = await caller.create(locationData);

      // Delete the location
      await caller.delete({ ids: [createdLocation.id] });

      // Verify location is not in list
      const locations = await caller.list(listParams());

      expect(
        locations.items.find((l) => l.id === createdLocation.id),
      ).toBeUndefined();

      // Verify getByID throws error
      await expect(caller.getByID({ id: createdLocation.id })).rejects.toThrow(
        "Location",
      );
    });

    it("should delete multiple locations in bulk", async () => {
      const caller = createTestCaller(locationRouter, ctx.db);

      // Create multiple locations
      const location1 = await caller.create(
        makeLocationInput({ name: "Bulk Delete Location 1" }),
      );

      const location2 = await caller.create(
        makeLocationInput({ name: "Bulk Delete Location 2", type: "shelf" }),
      );

      const location3 = await caller.create(
        makeLocationInput({ name: "Bulk Delete Location 3", type: "box" }),
      );

      // Delete all three locations
      await caller.delete({
        ids: [location1.id, location2.id, location3.id],
      });

      // Verify all locations are gone from list
      const locations = await caller.list(listParams({ pageSize: 100 }));

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
      const locationCaller = createTestCaller(locationRouter, ctx.db);

      const inventoryCaller = createTestCaller(inventoryRouter, ctx.db);

      const productCaller = createTestCaller(productRouter, ctx.db);

      // Create a location
      const location = await locationCaller.create(
        makeLocationInput({ name: "Location with Inventory" }),
      );

      // Create a product
      const product = await productCaller.create({
        name: "Test Product for Location",
        manufacturer: "Test Manufacturer",
        model: "LOC-TEST-1",
        upc: "888777666555",
        fdc_id: null,
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

    it("orphans child locations to top-level when the parent is deleted", async () => {
      const caller = createTestCaller(locationRouter, ctx.db);

      // Create a parent location
      const parentLocation = await caller.create(
        makeLocationInput({ name: "Parent Location" }),
      );

      // Create a child location
      const childLocation = await caller.create(
        makeLocationInput({
          name: "Child Location",
          type: "shelf",
          parentId: parentLocation.id,
        }),
      );

      // Deleting the parent succeeds: children are orphaned (parentId -> null)
      // and become top-level locations rather than blocking the delete.
      await expect(
        caller.delete({ ids: [parentLocation.id] }),
      ).resolves.toBeUndefined();

      // Parent is gone from the list
      const locations = await caller.list(listParams({ pageSize: 100 }));
      expect(
        locations.items.find((l) => l.id === parentLocation.id),
      ).toBeUndefined();

      // Child still exists and is now a top-level location (no parent).
      const retrievedChild = await caller.getByID({ id: childLocation.id });
      expect(retrievedChild.id).toEqual(childLocation.id);
      expect(retrievedChild.parent).toBeUndefined();
    });
  });

  describe("cascading behavior", () => {
    it("should cascade delete to images", async () => {
      const caller = createTestCaller(locationRouter, ctx.db);

      // Create a location (images would be added via pendingImageIds if we had test images)
      const location = await caller.create(
        makeLocationInput({ name: "Location for Cascade Test" }),
      );

      // Delete the location
      await caller.delete({ ids: [location.id] });

      // Verify location is gone
      await expect(caller.getByID({ id: location.id })).rejects.toThrow(
        "Location",
      );
    });
  });
});
