import { beforeEach, describe, expect, it } from "vitest";
import { type PrismaClient } from "@prisma/client";
import { buildTestDB } from "tooling/test-setup";
import { locationRouter } from "./location";
import { createCallerFactory } from "../trpc";

let prisma: PrismaClient;

describe("location router", () => {
  beforeEach(async () => {
    // Get a isolated test database for each test
    const res = await buildTestDB();
    prisma = res.prisma;
    return res.teardown;
  });

  it("should create and retrieve a location", async () => {
    // Create a test caller for the location router
    const createCaller = createCallerFactory(locationRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create a test location
    const locationData = {
      name: "Test Kitchen",
      type: "room" as const,
      parentId: null,
    };

    // Create the location
    const createdLocation = await caller.create(locationData);

    // Verify the location was created correctly
    expect(createdLocation.id).toBeDefined();
    expect(createdLocation.name).toEqual(locationData.name);
    expect(createdLocation.type).toEqual(locationData.type);

    // Retrieve the location by ID
    const retrievedLocation = await caller.getByID({ id: createdLocation.id });

    // Verify retrieved location matches created location
    expect(retrievedLocation.id).toEqual(createdLocation.id);
    expect(retrievedLocation.name).toEqual(createdLocation.name);
    expect(retrievedLocation.type).toEqual(createdLocation.type);
    expect(retrievedLocation.parent).toBeUndefined();
    expect(retrievedLocation.children).toEqual([]);
  });

  it("should create location with parent-child relationship", async () => {
    // Create a test caller for the location router
    const createCaller = createCallerFactory(locationRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create a parent location
    const parentLocationData = {
      name: "Kitchen",
      type: "room" as const,
      parentId: null,
    };

    const parentLocation = await caller.create(parentLocationData);

    // Create a child location
    const childLocationData = {
      name: "Kitchen Cabinet",
      type: "cabinet" as const,
      parentId: parentLocation.id,
    };

    const childLocation = await caller.create(childLocationData);

    // Verify the child location has correct parent reference
    expect(childLocation.parent?.id).toEqual(parentLocation.id);
    expect(childLocation.parent?.name).toEqual(parentLocation.name);

    // Retrieve the parent and verify it has the child
    const retrievedParent = await caller.getByID({ id: parentLocation.id });
    expect(retrievedParent.children).toHaveLength(1);
    expect(retrievedParent.children?.[0].id).toEqual(childLocation.id);
    expect(retrievedParent.children?.[0].name).toEqual(childLocation.name);
  });

  it("should list locations with filtering", async () => {
    // Create a test caller for the location router
    const createCaller = createCallerFactory(locationRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create multiple test locations
    const locationData1 = {
      name: "Kitchen",
      type: "room" as const,
      parentId: null,
    };

    const locationData2 = {
      name: "Living Room",
      type: "room" as const,
      parentId: null,
    };

    const locationData3 = {
      name: "Kitchen Shelf",
      type: "shelf" as const,
      parentId: null,
    };

    // Create the locations
    await caller.create(locationData1);
    await caller.create(locationData2);
    await caller.create(locationData3);

    // Test listing without filters
    const allLocations = await caller.list({
      filters: {},
      pagination: { pageSize: 10, pageIndex: 0 },
      sort: { orderBy: "name", direction: "asc" },
    });

    // Should return all locations
    expect(allLocations.items.length).toEqual(3);
    expect(allLocations.meta.totalCount).toEqual(3);

    // Test filtering by name
    const kitchenLocations = await caller.list({
      filters: { nameFilter: "Kitchen" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return only locations with "Kitchen" in name
    expect(kitchenLocations.items.length).toEqual(2);
    expect(kitchenLocations.meta.totalCount).toEqual(2);
    expect(kitchenLocations.items[0].name).toContain("Kitchen");
    expect(kitchenLocations.items[1].name).toContain("Kitchen");

    // Test filtering by type
    const roomLocations = await caller.list({
      filters: { itemTypeFilter: "room" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return only room type locations
    expect(roomLocations.items.length).toEqual(2);
    expect(roomLocations.meta.totalCount).toEqual(2);
    expect(roomLocations.items[0].type).toEqual("room");
    expect(roomLocations.items[1].type).toEqual("room");

    // Test filtering with no matches
    const drawerLocations = await caller.list({
      filters: { itemTypeFilter: "drawer" },
      pagination: { pageSize: 10, pageIndex: 0 },
    });

    // Should return no locations
    expect(drawerLocations.items.length).toEqual(0);
    expect(drawerLocations.meta.totalCount).toEqual(0);
  });

  it("should update a location", async () => {
    // Create a test caller for the location router
    const createCaller = createCallerFactory(locationRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create a test location
    const locationData = {
      name: "Original Name",
      type: "room" as const,
      parentId: null,
    };

    // Create the location
    const createdLocation = await caller.create(locationData);

    // Update the location
    const updatedLocation = await caller.update({
      id: createdLocation.id,
      data: {
        name: "Updated Kitchen",
        type: "cabinet",
      },
    });

    // Verify the location was updated correctly
    expect(updatedLocation.id).toEqual(createdLocation.id);
    expect(updatedLocation.name).toEqual("Updated Kitchen");
    expect(updatedLocation.type).toEqual("cabinet");

    // Retrieve the location to verify changes persisted
    const retrievedLocation = await caller.getByID({ id: createdLocation.id });
    expect(retrievedLocation.name).toEqual("Updated Kitchen");
    expect(retrievedLocation.type).toEqual("cabinet");
  });

  it("should handle partial updates correctly", async () => {
    // Create a test caller for the location router
    const createCaller = createCallerFactory(locationRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create a test location
    const locationData = {
      name: "Test Location",
      type: "room" as const,
      parentId: null,
    };

    // Create the location
    const createdLocation = await caller.create(locationData);

    // Update only the name
    const updatedLocation = await caller.update({
      id: createdLocation.id,
      data: {
        name: "Updated Name Only",
      },
    });

    // Verify only the name was updated
    expect(updatedLocation.id).toEqual(createdLocation.id);
    expect(updatedLocation.name).toEqual("Updated Name Only");
    expect(updatedLocation.type).toEqual(locationData.type); // Unchanged

    // Retrieve the location to verify other fields unchanged
    const retrievedLocation = await caller.getByID({ id: createdLocation.id });
    expect(retrievedLocation.name).toEqual("Updated Name Only");
    expect(retrievedLocation.type).toEqual("room"); // Unchanged
  });

  it("should build location tree correctly", async () => {
    // Create a test caller for the location router
    const createCaller = createCallerFactory(locationRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create a hierarchical structure: Kitchen -> Cabinet -> Shelf
    const kitchen = await caller.create({
      name: "Kitchen",
      type: "room" as const,
      parentId: null,
    });

    const cabinet = await caller.create({
      name: "Kitchen Cabinet",
      type: "cabinet" as const,
      parentId: kitchen.id,
    });

    await caller.create({
      name: "Cabinet Shelf",
      type: "shelf" as const,
      parentId: cabinet.id,
    });

    // Also create a separate room
    await caller.create({
      name: "Living Room",
      type: "room" as const,
      parentId: null,
    });

    // Get the location tree
    const tree = await caller.makeTree();

    // Should return top-level locations (rooms in this case)
    expect(tree).toHaveLength(2);

    // Find the kitchen in the tree
    const kitchenInTree = tree.find((loc) => loc.name === "Kitchen");
    expect(kitchenInTree).toBeDefined();
    expect(kitchenInTree?.children).toHaveLength(1);
    expect(kitchenInTree?.children?.[0].name).toEqual("Kitchen Cabinet");
    expect(kitchenInTree?.children?.[0].children).toHaveLength(1);
    expect(kitchenInTree?.children?.[0].children?.[0].name).toEqual(
      "Cabinet Shelf",
    );

    // Find the living room in the tree
    const livingRoomInTree = tree.find((loc) => loc.name === "Living Room");
    expect(livingRoomInTree).toBeDefined();
    expect(livingRoomInTree?.children).toEqual([]);
  });

  it("should get location types count", async () => {
    // Create a test caller for the location router
    const createCaller = createCallerFactory(locationRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create locations of different types
    await caller.create({
      name: "Kitchen",
      type: "room" as const,
      parentId: null,
    });

    await caller.create({
      name: "Living Room",
      type: "room" as const,
      parentId: null,
    });

    await caller.create({
      name: "Kitchen Cabinet",
      type: "cabinet" as const,
      parentId: null,
    });

    await caller.create({
      name: "Kitchen Shelf",
      type: "shelf" as const,
      parentId: null,
    });

    await caller.create({
      name: "Another Shelf",
      type: "shelf" as const,
      parentId: null,
    });

    // Get location types count
    const typesCount = await caller.getLocationTypesCount();

    // Verify counts
    expect(typesCount.room).toEqual(2);
    expect(typesCount.cabinet).toEqual(1);
    expect(typesCount.shelf).toEqual(2);
    expect(typesCount.bag).toEqual(0);
    expect(typesCount.crate).toEqual(0);
    expect(typesCount["half-crate"]).toEqual(0);
    expect(typesCount.table).toEqual(0);
    expect(typesCount.drawer).toEqual(0);
    expect(typesCount.cart).toEqual(0);
  });

  it("should handle deep parent-child hierarchy", async () => {
    // Create a test caller for the location router
    const createCaller = createCallerFactory(locationRouter);
    const caller = createCaller({
      headers: new Headers(),
      db: prisma,
      auth: undefined,
    });

    // Create a deep hierarchy: Room -> Cabinet -> Shelf -> Crate
    const room = await caller.create({
      name: "Storage Room",
      type: "room" as const,
      parentId: null,
    });

    const cabinet = await caller.create({
      name: "Storage Cabinet",
      type: "cabinet" as const,
      parentId: room.id,
    });

    const shelf = await caller.create({
      name: "Top Shelf",
      type: "shelf" as const,
      parentId: cabinet.id,
    });

    const crate = await caller.create({
      name: "Small Crate",
      type: "crate" as const,
      parentId: shelf.id,
    });

    // Retrieve the deepest location and verify parent hierarchy
    const retrievedCrate = await caller.getByID({ id: crate.id });

    expect(retrievedCrate.name).toEqual("Small Crate");
    expect(retrievedCrate.parent?.name).toEqual("Top Shelf");
    expect(retrievedCrate.parent?.parent?.name).toEqual("Storage Cabinet");
    expect(retrievedCrate.parent?.parent?.parent?.name).toEqual("Storage Room");
    expect(retrievedCrate.parent?.parent?.parent?.parent).toBeUndefined();
  });
});
