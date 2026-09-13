import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import { testEntityId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishOptions } from "~/server/background-tasks/publish";
import { Database } from "~/server/db";

import {
  mutationSideEffectManifest,
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
  readonly refreshed: Array<{ entityType: string; entityId: string }> = [];
  readonly inventoryRefs: Array<{ entityType: "inventory"; entityId: string }> =
    [];
  readonly markProblemCountsDirty = vi.fn(async () => {
    if (this.problemCountsError) throw this.problemCountsError;
  });
  problemCountsError: Error | null = null;

  readonly ports = {
    publishTasks: async (_db, tasks, options) => {
      this.published.push({ tasks, options });
    },
    markProblemCountsDirty: () => this.markProblemCountsDirty(),
    findInventoryEmbeddingRefsForProducts: async () => this.inventoryRefs,
    findInventoryEmbeddingRefsForLocations: async () => [],
    findRecipeEmbeddingRefsForIngredients: async () => [],
    findTaskEmbeddingRefsForProducts: async () => [],
    findWishEmbeddingRefsForProducts: async () => [],
    findMealEmbeddingRefsForRecipes: async () => [],
    findTrackerEmbeddingRefsForProjects: async () => [],
    findEmbeddingRefsForVendors: async () => [],
    findEmbeddingRefsForPurchases: async () => [],
    findTransactionEmbeddingRefsForAccounts: async () => [],
    findCommercialEmbeddingRefsForExpenses: async () => [],
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
        entityType: "product",
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
      entityType: "inventory",
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
        ? { entityType: task.entityType, entityId: task.entityId }
        : null,
    );
    expect(refreshedRefs).toEqual(
      expect.arrayContaining([
        { entityType: "product", entityId: productId },
        { entityType: "inventory", entityId: inventoryId },
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
      expect.arrayContaining([{ entityType: "product", entityId: productId }]),
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

  it("does not reject a committed mutation when marking problem counts dirty fails", async () => {
    memory.problemCountsError = new Error("KV write failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(
      runMutationSideEffects(
        db,
        {
          action: "updated",
          entity: {
            entity: "project",
            id: testEntityId("project", "00000000-0000-4000-8000-000000000008"),
          },
          source: "project.update",
        },
        memory.ports,
      ),
    ).resolves.toBeUndefined();
    expect(memory.markProblemCountsDirty).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      "problems.counts.dirty-mark.failed",
      expect.objectContaining({
        source: "project.update",
        error: memory.problemCountsError,
      }),
    );
    consoleError.mockRestore();
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
      inventoryIds.map((entityId) => ({ entityType: "inventory", entityId })),
    );
    expect(memory.published).toHaveLength(1);
    const refreshedRefs = memory.published[0]?.tasks.map((task) =>
      task.kind === "entity-embedding.refresh"
        ? `${task.entityType}:${task.entityId}`
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
      entityType: "inventory",
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
        ? `${task.entityType}:${task.entityId}`
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

  it("does not reject the wave when marking problem counts dirty fails", async () => {
    memory.problemCountsError = new Error("KV write failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(
      runMutationSideEffectsForEntities(
        db,
        [
          {
            action: "updated",
            entity: {
              entity: "project",
              id: testEntityId(
                "project",
                "00000000-0000-4000-8000-000000000016",
              ),
            },
            source: "test.bulk",
          },
        ],
        memory.ports,
      ),
    ).resolves.toBeUndefined();
    expect(memory.markProblemCountsDirty).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
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

  it("declares lifecycle hooks for every supported entity", () => {
    expect(Object.keys(mutationSideEffectManifest).sort()).toEqual([
      "cookbook",
      "expense",
      "financialAccount",
      "financialTransaction",
      "image",
      "ingredient",
      "inventory",
      "location",
      "meal",
      "product",
      "project",
      "purchase",
      "recipe",
      "task",
      "vendor",
      "wish",
    ]);
    for (const handlers of Object.values(mutationSideEffectManifest)) {
      expect(handlers).toHaveProperty("onCreate");
      expect(handlers).toHaveProperty("onUpdate");
      expect(handlers).toHaveProperty("onDelete");
    }
  });
});
