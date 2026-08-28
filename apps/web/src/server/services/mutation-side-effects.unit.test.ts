import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import { testEntityId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { Database } from "~/server/db";

import {
  mutationSideEffectEventSchema,
  mutationSideEffectManifest,
  type MutationSideEffectPorts,
  runMutationSideEffectsForEntities,
} from "./mutation-side-effects";

const db = new Database(() => {
  throw new Error(
    "Mutation-side-effect unit ports do not resolve a database runtime",
  );
});

function batch(totalJobs: number): BackgroundBatchRef {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    kind: "entity-embedding.refresh",
    source: "mutation",
    processor: "inline",
    status: "succeeded",
    totalJobs,
  };
}

class InMemoryMutationSideEffectPorts {
  readonly backgroundJobs: Array<{ jobs: Array<{ dedupeKey: string }> }> = [];
  readonly refreshed: Array<{ entityType: string; entityId: string }> = [];
  readonly inventoryRefs: Array<{ entityType: "inventory"; entityId: string }> =
    [];

  readonly ports = {
    dispatchBackgroundJobs: async (_db, input) => {
      this.backgroundJobs.push({ jobs: input.jobs });
      return {
        batch: batch(input.jobs.length),
        batchId: "batch-1",
        jobIds: [],
      };
    },
    dispatchLocationValuationRecompute: async () => ({
      batch: batch(1),
      batchId: "valuation-1",
      jobIds: [],
    }),
    dispatchProblemCountsRefresh: async () => null,
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
    refreshSearchDocument: async () => undefined,
    refreshSearchDocuments: async (_db, refs) => {
      this.refreshed.push(...refs);
      return undefined;
    },
  } satisfies MutationSideEffectPorts;
}

describe("runMutationSideEffectsForEntities batching", () => {
  let memory: InMemoryMutationSideEffectPorts;

  beforeEach(() => {
    memory = new InMemoryMutationSideEffectPorts();
  });

  it("dispatches one entity-embedding batch per wave, not one per entity", async () => {
    const inventoryIds = [
      testEntityId("inventory", "00000000-0000-4000-8000-000000000001"),
      testEntityId("inventory", "00000000-0000-4000-8000-000000000002"),
      testEntityId("inventory", "00000000-0000-4000-8000-000000000003"),
    ];

    await runMutationSideEffectsForEntities(
      db,
      inventoryIds.map((entityId) => ({
        action: "created" as const,
        entity: { entityType: "inventory" as const, entityId },
        source: "test.bulk",
      })),
      memory.ports,
    );

    expect(memory.refreshed).toEqual(
      inventoryIds.map((entityId) => ({ entityType: "inventory", entityId })),
    );
    expect(memory.backgroundJobs).toHaveLength(1);
    expect(
      memory.backgroundJobs[0]?.jobs.map((job) => job.dedupeKey).sort(),
    ).toEqual(
      inventoryIds
        .map((id) => `entity-embedding.refresh:inventory:${id}`)
        .sort(),
    );
  });

  it("dedupes embedding refs collected across handlers in the same wave", async () => {
    const productId = testEntityId(
      "product",
      "00000000-0000-4000-8000-000000000004",
    );
    const inventoryId = testEntityId(
      "inventory",
      "00000000-0000-4000-8000-000000000005",
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
          entity: { entityType: "product", entityId: productId },
          source: "test.bulk",
        },
        {
          action: "updated",
          entity: { entityType: "inventory", entityId: inventoryId },
          source: "test.bulk",
        },
      ],
      memory.ports,
    );

    expect(
      memory.backgroundJobs[0]?.jobs.map((job) => job.dedupeKey).sort(),
    ).toEqual(
      [
        `entity-embedding.refresh:product:${productId}`,
        `entity-embedding.refresh:inventory:${inventoryId}`,
      ].sort(),
    );
  });
});

describe("mutation side effects manifest", () => {
  it("parses typed mutation entity refs", () => {
    expect(
      mutationSideEffectEventSchema.parse({
        action: "updated",
        entity: {
          entityType: "product",
          entityId: "00000000-0000-4000-8000-000000000001",
        },
        source: "test.product",
      }),
    ).toMatchObject({ entity: { entityType: "product" } });
  });

  it("declares lifecycle hooks for every supported entity", () => {
    for (const handlers of Object.values(mutationSideEffectManifest)) {
      expect(handlers).toHaveProperty("onCreate");
      expect(handlers).toHaveProperty("onUpdate");
      expect(handlers).toHaveProperty("onDelete");
    }
  });
});
