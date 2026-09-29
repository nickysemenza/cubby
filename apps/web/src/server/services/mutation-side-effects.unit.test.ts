import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import { testEntityId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it } from "vitest";

import type { PublishOptions } from "~/server/background-tasks/publish";
import { Database } from "~/server/db";

import {
  type MutationSideEffectEvent,
  type MutationSideEffectPorts,
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "./mutation-side-effects";

const db = new Database(() => {
  throw new Error(
    "Mutation-side-effect unit ports do not resolve a database runtime",
  );
});

class InMemoryMutationSideEffectPorts {
  readonly published: Array<{
    tasks: readonly BackgroundTaskInput[];
    options: PublishOptions;
  }> = [];
  readonly refreshed: Array<{ entityKind: string; entityId: string }> = [];
  readonly inventoryRefs: Array<{ entityKind: "inventory"; entityId: string }> =
    [];
  readonly productRefs: Array<{ entityKind: "product"; entityId: string }> = [];
  readonly plantingRefs: Array<{ entityKind: "planting"; entityId: string }> =
    [];
  readonly gardenEntryRefs: Array<{
    entityKind: "gardenEntry";
    entityId: string;
  }> = [];
  readonly ports = {
    publishTasks: async (_db, tasks, options) => {
      this.published.push({ tasks, options });
    },
    findChildTaskEmbeddingRefs: async () => [],
    findInventoryEmbeddingRefsForProducts: async () => this.inventoryRefs,
    findProductEmbeddingRefsForCategories: async () => this.productRefs,
    findInventoryEmbeddingRefsForLocations: async () => [],
    findRecipeEmbeddingRefsForIngredients: async () => [],
    findTaskEmbeddingRefsForProducts: async () => [],
    findWishEmbeddingRefsForProducts: async () => [],
    findMealEmbeddingRefsForRecipes: async () => [],
    findPlantingEmbeddingRefsForPlants: async () => this.plantingRefs,
    findPlantingEmbeddingRefsForLocations: async () => this.plantingRefs,
    findGardenEntryEmbeddingRefsForLocations: async () => this.gardenEntryRefs,
    findGardenEntryEmbeddingRefsForPlantings: async () => this.gardenEntryRefs,
    findTrackerEmbeddingRefsForProjects: async () => [],
    findEmbeddingRefsForVendors: async () => [],
    findEmbeddingRefsForPurchases: async () => [],
    findTransactionEmbeddingRefsForAccounts: async () => [],
    findCommercialEmbeddingRefsForExpenses: async () => [],
    findDirectImageSearchOwnerRefs: async () => [],
    refreshSearchDocuments: async (_db, refs) => {
      this.refreshed.push(...refs);
    },
  } satisfies MutationSideEffectPorts;

  /** Every embedding-refresh task published across all `publishTasks` calls. */
  get embeddingRefreshTasks(): BackgroundTaskInput[] {
    return this.published.flatMap(({ tasks }) => tasks);
  }
}

describe("runMutationSideEffects", () => {
  let memory: InMemoryMutationSideEffectPorts;

  beforeEach(() => {
    memory = new InMemoryMutationSideEffectPorts();
  });

  it("publishes an entity-embedding.refresh task for the entity's own ref on create", async () => {
    const productId = testEntityId(
      "product",
      "00000000-0000-4000-8000-000000000001",
    );

    await runMutationSideEffects(
      db,
      {
        action: "created",
        entity: { entity: "product", id: productId },
        source: "product.create",
      },
      memory.ports,
    );

    expect(memory.embeddingRefreshTasks).toEqual([
      expect.objectContaining({
        kind: "entity-embedding.refresh",
        entityKind: "product",
        entityId: productId,
      }),
    ]);
  });

  it("fans out an entity-embedding.refresh task to inventory refs on product update", async () => {
    const productId = testEntityId(
      "product",
      "00000000-0000-4000-8000-000000000002",
    );
    const inventoryId = testEntityId(
      "inventory",
      "00000000-0000-4000-8000-000000000003",
    );
    memory.inventoryRefs.push({
      entityKind: "inventory",
      entityId: inventoryId,
    });

    await runMutationSideEffects(
      db,
      {
        action: "updated",
        entity: { entity: "product", id: productId },
        source: "product.update",
      },
      memory.ports,
    );

    const refreshedRefs = memory.embeddingRefreshTasks.map((task) =>
      task.kind === "entity-embedding.refresh"
        ? { entityKind: task.entityKind, entityId: task.entityId }
        : null,
    );
    expect(refreshedRefs).toEqual(
      expect.arrayContaining([
        { entityKind: "product", entityId: productId },
        { entityKind: "inventory", entityId: inventoryId },
      ]),
    );
  });

  it("refreshes Product and Inventory projections after a taxonomy mutation", async () => {
    const categoryId = testEntityId(
      "productCategory",
      "00000000-0000-4000-8000-000000000021",
    );
    const productId = testEntityId(
      "product",
      "00000000-0000-4000-8000-000000000022",
    );
    const inventoryId = testEntityId(
      "inventory",
      "00000000-0000-4000-8000-000000000023",
    );
    memory.productRefs.push({ entityKind: "product", entityId: productId });
    memory.inventoryRefs.push({
      entityKind: "inventory",
      entityId: inventoryId,
    });

    await runMutationSideEffects(
      db,
      {
        action: "updated",
        entity: { entity: "productCategory", id: categoryId },
        source: "product-category.update",
      },
      memory.ports,
    );

    expect(memory.refreshed).toEqual(
      expect.arrayContaining([
        { entityKind: "product", entityId: productId },
        { entityKind: "inventory", entityId: inventoryId },
      ]),
    );
    expect(memory.embeddingRefreshTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityKind: "product", entityId: productId }),
        expect.objectContaining({
          entityKind: "inventory",
          entityId: inventoryId,
        }),
      ]),
    );
  });

  it("fans out an entity-embedding.refresh task to planting refs on plant update", async () => {
    const plantId = testEntityId(
      "plant",
      "00000000-0000-4000-8000-000000000020",
    );
    const plantingId = testEntityId(
      "planting",
      "00000000-0000-4000-8000-000000000021",
    );
    memory.plantingRefs.push({ entityKind: "planting", entityId: plantingId });

    await runMutationSideEffects(
      db,
      {
        action: "updated",
        entity: { entity: "plant", id: plantId },
        source: "plant.update",
      },
      memory.ports,
    );

    const refreshedRefs = memory.embeddingRefreshTasks.map((task) =>
      task.kind === "entity-embedding.refresh"
        ? { entityKind: task.entityKind, entityId: task.entityId }
        : null,
    );
    expect(refreshedRefs).toEqual(
      expect.arrayContaining([
        { entityKind: "plant", entityId: plantId },
        { entityKind: "planting", entityId: plantingId },
      ]),
    );
  });

  it("fans out entity-embedding.refresh tasks to planting and garden-entry refs on location update", async () => {
    const locationId = testEntityId(
      "location",
      "00000000-0000-4000-8000-000000000022",
    );
    const plantingId = testEntityId(
      "planting",
      "00000000-0000-4000-8000-000000000023",
    );
    const gardenEntryId = testEntityId(
      "gardenEntry",
      "00000000-0000-4000-8000-000000000024",
    );
    memory.plantingRefs.push({ entityKind: "planting", entityId: plantingId });
    memory.gardenEntryRefs.push({
      entityKind: "gardenEntry",
      entityId: gardenEntryId,
    });

    await runMutationSideEffects(
      db,
      {
        action: "updated",
        entity: { entity: "location", id: locationId },
        source: "location.update",
      },
      memory.ports,
    );

    const refreshedRefs = memory.embeddingRefreshTasks.map((task) =>
      task.kind === "entity-embedding.refresh"
        ? { entityKind: task.entityKind, entityId: task.entityId }
        : null,
    );
    expect(refreshedRefs).toEqual(
      expect.arrayContaining([
        { entityKind: "location", entityId: locationId },
        { entityKind: "planting", entityId: plantingId },
        { entityKind: "gardenEntry", entityId: gardenEntryId },
      ]),
    );
  });

  it("publishes both location-ai tasks when location images changed", async () => {
    const locationId = testEntityId(
      "location",
      "00000000-0000-4000-8000-000000000004",
    );

    await runMutationSideEffects(
      db,
      {
        action: "updated",
        entity: { entity: "location", id: locationId },
        source: "location.update",
        locationImagesChanged: true,
      },
      memory.ports,
    );

    const kinds = memory.published.flatMap(({ tasks }) =>
      tasks.map((task) => task.kind),
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        "location-ai.description.refresh",
        "location-ai.inventory.refresh",
      ]),
    );
  });

  it("does not publish location-ai tasks when images did not change", async () => {
    const locationId = testEntityId(
      "location",
      "00000000-0000-4000-8000-000000000005",
    );

    await runMutationSideEffects(
      db,
      {
        action: "updated",
        entity: { entity: "location", id: locationId },
        source: "location.update",
        locationImagesChanged: false,
      },
      memory.ports,
    );

    const kinds = memory.published.flatMap(({ tasks }) =>
      tasks.map((task) => task.kind),
    );
    expect(kinds).not.toContain("location-ai.description.refresh");
    expect(kinds).not.toContain("location-ai.inventory.refresh");
  });

  it("refreshes the search projection by default", async () => {
    const productId = testEntityId(
      "product",
      "00000000-0000-4000-8000-000000000006",
    );

    await runMutationSideEffects(
      db,
      {
        action: "updated",
        entity: { entity: "product", id: productId },
        source: "product.update",
      },
      memory.ports,
    );

    expect(memory.refreshed).toEqual(
      expect.arrayContaining([{ entityKind: "product", entityId: productId }]),
    );
  });

  it("skips the search projection when projection: 'skip' is passed", async () => {
    const productId = testEntityId(
      "product",
      "00000000-0000-4000-8000-000000000007",
    );

    await runMutationSideEffects(
      db,
      {
        action: "updated",
        entity: { entity: "product", id: productId },
        source: "product.update",
      },
      memory.ports,
      { projection: "skip" },
    );

    expect(memory.refreshed).toEqual([]);
  });
});

describe("runMutationSideEffectsForEntities batching", () => {
  let memory: InMemoryMutationSideEffectPorts;

  beforeEach(() => {
    memory = new InMemoryMutationSideEffectPorts();
  });

  it("publishes one task list per wave, not one per entity", async () => {
    const inventoryIds = [
      testEntityId("inventory", "00000000-0000-4000-8000-000000000010"),
      testEntityId("inventory", "00000000-0000-4000-8000-000000000011"),
      testEntityId("inventory", "00000000-0000-4000-8000-000000000012"),
    ];

    await runMutationSideEffectsForEntities(
      db,
      inventoryIds.map((entityId) => ({
        action: "created" as const,
        entity: { entity: "inventory" as const, id: entityId },
        source: "test.bulk",
      })),
      memory.ports,
    );

    expect(memory.refreshed).toEqual(
      inventoryIds.map((entityId) => ({ entityKind: "inventory", entityId })),
    );
    expect(memory.published).toHaveLength(1);
    const refreshedRefs = memory.published[0]?.tasks.map((task) =>
      task.kind === "entity-embedding.refresh"
        ? `${task.entityKind}:${task.entityId}`
        : task.kind,
    );
    expect(refreshedRefs?.sort()).toEqual(
      inventoryIds.map((id) => `inventory:${id}`).sort(),
    );
  });

  it("dedupes embedding refs collected across handlers in the same wave", async () => {
    const productId = testEntityId(
      "product",
      "00000000-0000-4000-8000-000000000013",
    );
    const inventoryId = testEntityId(
      "inventory",
      "00000000-0000-4000-8000-000000000014",
    );
    memory.inventoryRefs.push({
      entityKind: "inventory",
      entityId: inventoryId,
    });

    await runMutationSideEffectsForEntities(
      db,
      [
        {
          action: "updated",
          entity: { entity: "product", id: productId },
          source: "test.bulk",
        },
        {
          action: "updated",
          entity: { entity: "inventory", id: inventoryId },
          source: "test.bulk",
        },
      ],
      memory.ports,
    );

    expect(memory.published).toHaveLength(1);
    const refreshedRefs = memory.published[0]?.tasks.map((task) =>
      task.kind === "entity-embedding.refresh"
        ? `${task.entityKind}:${task.entityId}`
        : task.kind,
    );
    expect(refreshedRefs?.sort()).toEqual(
      [`product:${productId}`, `inventory:${inventoryId}`].sort(),
    );
  });

  it("skips refreshSearchDocuments when projection: 'skip' is passed", async () => {
    const productId = testEntityId(
      "product",
      "00000000-0000-4000-8000-000000000015",
    );

    await runMutationSideEffectsForEntities(
      db,
      [
        {
          action: "updated",
          entity: { entity: "product", id: productId },
          source: "test.bulk",
        },
      ],
      memory.ports,
      { projection: "skip" },
    );

    expect(memory.refreshed).toEqual([]);
  });
});

describe("mutation side effects manifest", () => {
  it("correlates supported entity names with canonical branded ids", () => {
    const event: MutationSideEffectEvent = {
      action: "updated",
      entity: {
        entity: "product",
        id: testEntityId("product", "00000000-0000-4000-8000-000000000001"),
      },
      source: "test.product",
    };
    expect(event.entity.entity).toBe("product");
  });
});
