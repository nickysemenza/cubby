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
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  getBackgroundBatchDetail,
  listBackgroundBatches,
} from "../repo/background-jobs";
import { getSemanticEmbeddingConfig } from "../semantic/config";
import { runMutationSideEffects } from "./mutation-side-effects";
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

  it("location update enqueues AI refresh jobs", async () => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Manifest AI bin" }),
      ctx.actor,
    );

    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "location", entityId: location.id },
      source: "test.location.update",
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

  it("delete events soft-delete direct entity embeddings", async () => {
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

    await runMutationSideEffects(ctx.db, {
      action: "deleted",
      entity: { entityType: "product", entityId: product.id },
      source: "test.product.delete",
    });

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
