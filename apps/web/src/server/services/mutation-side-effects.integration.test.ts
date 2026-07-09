import { unsafeProductId } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  findOrphanedEntityEmbeddings,
  getEntityEmbeddingDeletedAt,
  getEntityEmbeddingDeletedAtForRef,
  upsertEntityEmbedding,
} from "~/server/repo/entity-embedding";
import { createInventoryEntry } from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct, deleteProducts } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  getBackgroundBatchDetail,
  listBackgroundBatches,
} from "../repo/background-jobs";
import { getSemanticEmbeddingConfig } from "../semantic/config";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "./mutation-side-effects";
import { cleanupOrphanedEntityEmbeddings } from "./problems.service";

describe("mutation side effects integration", () => {
  const ctx = withTestDb();

  it("product update enqueues product and related inventory embedding refreshes", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Manifest tarp" }),
      ctx.actor,
    );
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Manifest bin" }),
      ctx.actor,
    );
    const inventory = await createInventoryEntry(
      ctx.db,
      {
        productId: product.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "product", entityId: product.id },
      source: "test.product.update",
    });

    const batches = await listBackgroundBatches(ctx.db, 20);
    const embeddingBatches = batches.filter(
      (batch) =>
        batch.kind === "entity-embedding.refresh" &&
        (batch.metadata as { source?: string } | null)?.source ===
          "test.product.update",
    );
    expect(embeddingBatches.length).toBeGreaterThan(0);
    const details = await Promise.all(
      embeddingBatches.map((batch) =>
        getBackgroundBatchDetail(ctx.db, batch.id),
      ),
    );
    const jobs = details.flatMap((detail) => detail?.jobs ?? []);
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: { entityType: "product", entityId: product.id },
        }),
        expect.objectContaining({
          payload: { entityType: "inventory", entityId: inventory.id },
        }),
      ]),
    );
  });

  it("location update with image changes enqueues AI refresh jobs", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Manifest AI bin" }),
      ctx.actor,
    );

    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "location", entityId: location.id },
      source: "test.location.update",
      locationImagesChanged: true,
    });

    const batches = await listBackgroundBatches(ctx.db, 20);
    const matchingKinds = batches
      .filter(
        (batch) =>
          (batch.metadata as { source?: string } | null)?.source ===
          "test.location.update",
      )
      .map((batch) => batch.kind);
    expect(matchingKinds).toEqual(
      expect.arrayContaining([
        "location-ai.description.refresh",
        "location-ai.inventory.refresh",
      ]),
    );
  });

  it("location update without image changes skips AI refresh jobs", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Manifest rename bin" }),
      ctx.actor,
    );

    // A rename (no image change) must not fire vision analysis — the analysis
    // fingerprint includes the name, so it would otherwise be a paid cache miss.
    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "location", entityId: location.id },
      source: "test.location.rename",
    });

    const batches = await listBackgroundBatches(ctx.db, 20);
    const matchingKinds = batches
      .filter(
        (batch) =>
          (batch.metadata as { source?: string } | null)?.source ===
          "test.location.rename",
      )
      .map((batch) => batch.kind);
    expect(matchingKinds).not.toContain("location-ai.description.refresh");
    expect(matchingKinds).not.toContain("location-ai.inventory.refresh");
  });

  it("bulk inventory wave enqueues exactly one valuation recompute", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Manifest valuation bin" }),
      ctx.actor,
    );
    // Distinct products — (productId, locationId) is unique on InventoryEntry.
    const entries = [];
    for (const n of [1, 2, 3]) {
      const product = await createProduct(
        ctx.db,
        makeProductInput({ name: `Manifest valuation product ${n}` }),
        ctx.actor,
      );
      entries.push(
        await createInventoryEntry(
          ctx.db,
          {
            productId: product.id,
            locationId: location.id,
            amount: { value: n, unit: "each" },
          },
          ctx.actor,
        ),
      );
    }

    await runMutationSideEffectsForEntities(
      ctx.db,
      entries.map((entry) => ({
        action: "updated" as const,
        entity: { entityType: "inventory" as const, entityId: entry.id },
        source: "test.inventory.bulk",
      })),
    );

    const batches = await listBackgroundBatches(ctx.db, 50);
    const valuationBatches = batches.filter(
      (batch) =>
        batch.kind === "location-valuation.recompute" &&
        (batch.metadata as { source?: string } | null)?.source ===
          "test.inventory.bulk",
    );
    // Whole-tree valuation must collapse to a single job, not one per entity.
    expect(valuationBatches).toHaveLength(1);
  });

  it("bulk wave enqueues exactly one entity-embedding batch for N entities", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Manifest embedding bin" }),
      ctx.actor,
    );
    const entries = [];
    for (const n of [1, 2, 3]) {
      const product = await createProduct(
        ctx.db,
        makeProductInput({ name: `Manifest embedding product ${n}` }),
        ctx.actor,
      );
      entries.push(
        await createInventoryEntry(
          ctx.db,
          {
            productId: product.id,
            locationId: location.id,
            amount: { value: n, unit: "each" },
          },
          ctx.actor,
        ),
      );
    }

    await runMutationSideEffectsForEntities(
      ctx.db,
      entries.map((entry) => ({
        action: "created" as const,
        entity: { entityType: "inventory" as const, entityId: entry.id },
        source: "test.embedding.bulk",
      })),
    );

    const batches = await listBackgroundBatches(ctx.db, 50);
    const embeddingBatches = batches.filter(
      (batch) =>
        batch.kind === "entity-embedding.refresh" &&
        (batch.metadata as { source?: string } | null)?.source ===
          "test.embedding.bulk",
    );
    // Three entities whose only handler is refreshOwnEmbedding must collapse
    // into a single batch (one transaction), not one batch per entity.
    expect(embeddingBatches).toHaveLength(1);
    const detail = await getBackgroundBatchDetail(
      ctx.db,
      embeddingBatches[0]!.id,
    );
    expect(detail?.jobs).toHaveLength(3);
    expect(detail?.jobs.map((job) => job.payload)).toEqual(
      expect.arrayContaining(
        entries.map((entry) =>
          expect.objectContaining({
            entityType: "inventory",
            entityId: entry.id,
          }),
        ),
      ),
    );
  });

  it("repo delete soft-deletes the entity's search embedding", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Manifest deleted embedding" }),
      ctx.actor,
    );
    const config = getSemanticEmbeddingConfig();
    await upsertEntityEmbedding(ctx.db, {
      entityType: "product",
      entityId: product.id,
      embeddingText: "product: Manifest deleted embedding",
      config,
      embedding: Array.from({ length: config.dimensions }, () => 0),
    });

    // Embedding cleanup lives in the repo delete cascade (not the mutation
    // side-effect), so it covers EVERY delete caller — including direct repo
    // deletes that skip runMutationSideEffects.
    await deleteProducts(ctx.db, [product.id], ctx.actor);

    const deletedAt = await getEntityEmbeddingDeletedAtForRef(ctx.db, {
      entityType: "product",
      entityId: product.id,
    });
    expect(deletedAt).toBeInstanceOf(Date);
  });

  it("orphaned embedding cleanup detects and soft-deletes dead refs", async () => {
    const config = getSemanticEmbeddingConfig();
    const deadProductId = unsafeProductId(
      "00000000-0000-4000-8000-000000000099",
    );
    await upsertEntityEmbedding(ctx.db, {
      entityType: "product",
      entityId: deadProductId,
      embeddingText: "product: dead semantic row",
      config,
      embedding: Array.from({ length: config.dimensions }, () => 0),
    });

    const orphaned = await findOrphanedEntityEmbeddings(ctx.db);
    const target = orphaned.find((row) => row.entityId === deadProductId);
    expect(target).toBeTruthy();

    const result = await cleanupOrphanedEntityEmbeddings(ctx.db, [target!.id]);
    expect(result.deleted).toBe(1);

    const deletedAt = await getEntityEmbeddingDeletedAt(ctx.db, target!.id);
    expect(deletedAt).toBeInstanceOf(Date);
  });
});
