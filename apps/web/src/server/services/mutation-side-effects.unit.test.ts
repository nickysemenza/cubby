import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import { unsafeInventoryId, unsafeProductId } from "@cubby/schemas/identifiers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "~/server/db";
import {
  mutationSideEffectEventSchema,
  mutationSideEffectManifest,
} from "./mutation-side-effects";

const dispatchBackgroundJobsMock = vi.hoisted(() => vi.fn());
const dispatchLocationValuationRecomputeMock = vi.hoisted(() => vi.fn());
const dispatchProblemCountsRefreshMock = vi.hoisted(() => vi.fn());
const findInventoryEmbeddingRefsForProductsMock = vi.hoisted(() => vi.fn());
const findInventoryEmbeddingRefsForLocationsMock = vi.hoisted(() => vi.fn());
const findRecipeEmbeddingRefsForIngredientsMock = vi.hoisted(() => vi.fn());
const findTaskEmbeddingRefsForProductsMock = vi.hoisted(() => vi.fn());
const findWishEmbeddingRefsForProductsMock = vi.hoisted(() => vi.fn());
const findMealEmbeddingRefsForRecipesMock = vi.hoisted(() => vi.fn());
const findTrackerEmbeddingRefsForProjectsMock = vi.hoisted(() => vi.fn());
const findEmbeddingRefsForVendorsMock = vi.hoisted(() => vi.fn());
const findEmbeddingRefsForPurchasesMock = vi.hoisted(() => vi.fn());
const findTransactionEmbeddingRefsForAccountsMock = vi.hoisted(() => vi.fn());
const findCommercialEmbeddingRefsForExpensesMock = vi.hoisted(() => vi.fn());
const refreshSearchDocumentMock = vi.hoisted(() => vi.fn());
const refreshSearchDocumentsMock = vi.hoisted(() => vi.fn());

vi.mock("~/server/background-dispatch", () => ({
  dispatchBackgroundJobs: dispatchBackgroundJobsMock,
  dispatchLocationValuationRecompute: dispatchLocationValuationRecomputeMock,
  dispatchProblemCountsRefresh: dispatchProblemCountsRefreshMock,
}));

vi.mock("~/server/repo/entity-embedding", () => ({
  findInventoryEmbeddingRefsForProducts:
    findInventoryEmbeddingRefsForProductsMock,
  findInventoryEmbeddingRefsForLocations:
    findInventoryEmbeddingRefsForLocationsMock,
  findRecipeEmbeddingRefsForIngredients:
    findRecipeEmbeddingRefsForIngredientsMock,
  findTaskEmbeddingRefsForProducts: findTaskEmbeddingRefsForProductsMock,
  findWishEmbeddingRefsForProducts: findWishEmbeddingRefsForProductsMock,
  findMealEmbeddingRefsForRecipes: findMealEmbeddingRefsForRecipesMock,
  findTrackerEmbeddingRefsForProjects: findTrackerEmbeddingRefsForProjectsMock,
  findEmbeddingRefsForVendors: findEmbeddingRefsForVendorsMock,
  findEmbeddingRefsForPurchases: findEmbeddingRefsForPurchasesMock,
  findTransactionEmbeddingRefsForAccounts:
    findTransactionEmbeddingRefsForAccountsMock,
  findCommercialEmbeddingRefsForExpenses:
    findCommercialEmbeddingRefsForExpensesMock,
}));

vi.mock("~/server/repo/search-document", () => ({
  refreshSearchDocument: refreshSearchDocumentMock,
  refreshSearchDocuments: refreshSearchDocumentsMock,
}));

function fakeBatchRef(overrides: Partial<BackgroundBatchRef> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    kind: "entity-embedding.refresh",
    source: "mutation",
    processor: "inline",
    status: "succeeded",
    totalJobs: 0,
    ...overrides,
  } satisfies BackgroundBatchRef;
}

describe("runMutationSideEffectsForEntities batching", () => {
  const db = {} as Database;

  beforeEach(() => {
    findInventoryEmbeddingRefsForProductsMock.mockResolvedValue([]);
    findInventoryEmbeddingRefsForLocationsMock.mockResolvedValue([]);
    findRecipeEmbeddingRefsForIngredientsMock.mockResolvedValue([]);
    findTaskEmbeddingRefsForProductsMock.mockResolvedValue([]);
    findWishEmbeddingRefsForProductsMock.mockResolvedValue([]);
    findMealEmbeddingRefsForRecipesMock.mockResolvedValue([]);
    findTrackerEmbeddingRefsForProjectsMock.mockResolvedValue([]);
    findEmbeddingRefsForVendorsMock.mockResolvedValue([]);
    findEmbeddingRefsForPurchasesMock.mockResolvedValue([]);
    findTransactionEmbeddingRefsForAccountsMock.mockResolvedValue([]);
    findCommercialEmbeddingRefsForExpensesMock.mockResolvedValue([]);
    refreshSearchDocumentMock.mockResolvedValue({ status: "upserted" });
    refreshSearchDocumentsMock.mockResolvedValue([]);
    dispatchProblemCountsRefreshMock.mockResolvedValue(null);
  });

  afterEach(() => {
    dispatchBackgroundJobsMock.mockReset();
    dispatchLocationValuationRecomputeMock.mockReset();
    dispatchProblemCountsRefreshMock.mockReset();
    findInventoryEmbeddingRefsForProductsMock.mockReset();
    findInventoryEmbeddingRefsForLocationsMock.mockReset();
    findRecipeEmbeddingRefsForIngredientsMock.mockReset();
    findTaskEmbeddingRefsForProductsMock.mockReset();
    findWishEmbeddingRefsForProductsMock.mockReset();
    findMealEmbeddingRefsForRecipesMock.mockReset();
    findTrackerEmbeddingRefsForProjectsMock.mockReset();
    findEmbeddingRefsForVendorsMock.mockReset();
    findEmbeddingRefsForPurchasesMock.mockReset();
    findTransactionEmbeddingRefsForAccountsMock.mockReset();
    findCommercialEmbeddingRefsForExpensesMock.mockReset();
    refreshSearchDocumentMock.mockReset();
    refreshSearchDocumentsMock.mockReset();
  });

  it("dispatches one entity-embedding batch per wave, not one per entity", async () => {
    const { runMutationSideEffectsForEntities } = await import(
      "./mutation-side-effects"
    );
    dispatchBackgroundJobsMock.mockResolvedValue({
      batchId: "batch-1",
      jobIds: ["job-1", "job-2", "job-3"],
      batch: fakeBatchRef({ totalJobs: 3 }),
    });
    dispatchLocationValuationRecomputeMock.mockResolvedValue({
      batchId: "batch-2",
      jobIds: ["job-4"],
      batch: fakeBatchRef({
        kind: "location-valuation.recompute",
        totalJobs: 1,
      }),
    });

    const inventoryIds = [
      unsafeInventoryId("00000000-0000-4000-8000-000000000001"),
      unsafeInventoryId("00000000-0000-4000-8000-000000000002"),
      unsafeInventoryId("00000000-0000-4000-8000-000000000003"),
    ];

    await runMutationSideEffectsForEntities(
      db,
      inventoryIds.map((entityId) => ({
        action: "created" as const,
        entity: { entityType: "inventory" as const, entityId },
        source: "test.bulk",
      })),
    );

    expect(refreshSearchDocumentsMock).toHaveBeenCalledWith(
      db,
      inventoryIds.map((entityId) => ({
        entityType: "inventory",
        entityId,
      })),
    );
    // Three entities whose only handler is refreshOwnEmbedding must collapse
    // into a single dispatchBackgroundJobs call carrying all three jobs,
    // instead of one call (transaction) per entity.
    expect(dispatchBackgroundJobsMock).toHaveBeenCalledTimes(1);
    const [, input] = dispatchBackgroundJobsMock.mock.calls[0] as [
      Database,
      { jobs: { dedupeKey: string }[] },
    ];
    expect(input.jobs).toHaveLength(3);
    expect(input.jobs.map((j) => j.dedupeKey).sort()).toEqual(
      inventoryIds
        .map((id) => `entity-embedding.refresh:inventory:${id}`)
        .sort(),
    );
    expect(dispatchProblemCountsRefreshMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes embedding refs collected across different handlers in the same wave", async () => {
    const { runMutationSideEffectsForEntities } = await import(
      "./mutation-side-effects"
    );
    dispatchBackgroundJobsMock.mockResolvedValue({
      batchId: "batch-1",
      jobIds: ["job-1", "job-2"],
      batch: fakeBatchRef({ totalJobs: 2 }),
    });
    dispatchLocationValuationRecomputeMock.mockResolvedValue({
      batchId: "batch-2",
      jobIds: ["job-3"],
      batch: fakeBatchRef({
        kind: "location-valuation.recompute",
        totalJobs: 1,
      }),
    });

    const productId = unsafeProductId("00000000-0000-4000-8000-000000000004");
    const inventoryId = unsafeInventoryId(
      "00000000-0000-4000-8000-000000000005",
    );
    // The product's own inventory-refresh handler and a direct inventory
    // event both surface the same inventory ref — the wave-wide dedupe must
    // collapse them into a single job, not two.
    findInventoryEmbeddingRefsForProductsMock.mockResolvedValue([
      { entityType: "inventory", entityId: inventoryId },
    ]);

    await runMutationSideEffectsForEntities(db, [
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
    ]);

    expect(dispatchBackgroundJobsMock).toHaveBeenCalledTimes(1);
    const [, input] = dispatchBackgroundJobsMock.mock.calls[0] as [
      Database,
      { jobs: { dedupeKey: string }[] },
    ];
    expect(input.jobs.map((j) => j.dedupeKey).sort()).toEqual(
      [
        `entity-embedding.refresh:product:${productId}`,
        `entity-embedding.refresh:inventory:${inventoryId}`,
      ].sort(),
    );
    expect(dispatchProblemCountsRefreshMock).toHaveBeenCalledTimes(1);
  });
});

describe("mutation side effects manifest", () => {
  it("parses typed mutation entity refs", () => {
    const parsed = mutationSideEffectEventSchema.parse({
      action: "updated",
      entity: {
        entityType: "product",
        entityId: "00000000-0000-4000-8000-000000000001",
      },
      source: "test.product",
    });

    expect(parsed).toMatchObject({
      action: "updated",
      entity: { entityType: "product" },
      source: "test.product",
    });
  });

  it("rejects mismatched entity ids", () => {
    expect(() =>
      mutationSideEffectEventSchema.parse({
        action: "updated",
        entity: { entityType: "product", entityId: "not-a-uuid" },
        source: "test.product",
      }),
    ).toThrow();
  });

  it("declares create update and delete hooks for every supported entity", () => {
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
