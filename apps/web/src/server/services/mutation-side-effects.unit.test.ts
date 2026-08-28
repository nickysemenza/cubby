import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import { testEntityId } from "@cubby/schemas/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import {
  mutationSideEffectEventSchema,
  mutationSideEffectManifest,
  type MutationSideEffectPorts,
  runMutationSideEffects,
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
  problemCountsError: Error | null = null;

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
    dispatchProblemCountsRefresh: async () => {
      if (this.problemCountsError) throw this.problemCountsError;
      return null;
    },
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

  it("does not reject a committed mutation when Problem-count refresh enqueue fails", async () => {
    const enqueueError = new Error("BackgroundJobKind is missing");
    memory.problemCountsError = enqueueError;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await expect(
      runMutationSideEffects(
        db,
        {
          action: "updated",
          entity: {
            entityType: "project",
            entityId: testEntityId(
              "project",
              "00000000-0000-4000-8000-000000000006",
            ),
          },
          source: "project.update",
        },
        memory.ports,
      ),
    ).resolves.toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      "problems.counts.refresh.enqueue.failed",
      expect.objectContaining({
        source: "project.update",
        error: enqueueError,
      }),
    );
    consoleError.mockRestore();
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

  it("rejects mismatched entity ids", () => {
    // A product-shaped event must carry a product UUID; accepting a malformed
    // id would let a side-effect handler enqueue work for an unreachable row.
    expect(() =>
      mutationSideEffectEventSchema.parse({
        action: "updated",
        entity: { entityType: "product", entityId: "not-a-uuid" },
        source: "test.product",
      }),
    ).toThrow(/Invalid UUID/);
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
