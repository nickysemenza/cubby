import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { entityEmbedding } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { findOrphanedEntityEmbeddings } from "~/server/repo/entity-embedding";
import {
  bulkMoveInventoryEntries,
  bulkProcessInventoryEntries,
  createInventoryEntry,
  deleteInventoryEntries,
  reconcileLocationSession,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

// F1 regression guard: the inventory manifest has onDelete: [], so a repo/bulk
// removal transaction is the ONLY place an inventory entry's search-embedding
// row gets cleaned up. Every removal path must cascade softDeleteEntityEmbeddingsTx
// in-tx — otherwise a removed entry leaves a live EntityEmbedding orphan that
// consumes HNSW candidate slots (recall degradation) and, in the hard-delete
// case, dangles forever with no FK. This exercises every removal path and asserts
// zero live orphans after each.
describe("inventory removal cascades entity embeddings (no orphans)", () => {
  const ctx = withTestDb();
  const amount = { value: 3, unit: "each" };

  // Seed a live search-embedding row for an entity (minimal 3-dim vector — the
  // HNSW index is partial on dimensions=1536, so small test vectors insert fine).
  const seedEmbedding = (entityType: SearchableEntity, entityId: string) =>
    getDb(ctx.db)
      .insert(entityEmbedding)
      .values({
        entityType,
        entityId,
        embeddingText: `${entityType} ${entityId}`,
        embeddingHash: `hash-${entityId}`,
        provider: "test",
        model: "test",
        dimensions: 3,
        embedding: [0, 0, 0],
      });

  const embeddingDeletedAt = async (entityId: string) =>
    (
      await getDb(ctx.db).query.entityEmbedding.findFirst({
        where: and(
          eq(entityEmbedding.entityType, "inventory"),
          eq(entityEmbedding.entityId, entityId),
        ),
        columns: { deletedAt: true },
      })
    )?.deletedAt;

  const seedEntry = async (locationName: string, productName: string) => {
    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: locationName }),
      TEST_ACTOR,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: productName }),
      TEST_ACTOR,
    );
    const entry = await createInventoryEntry(
      ctx.db,
      { productId: product.id, locationId: location.id, amount },
      TEST_ACTOR,
    );
    return { location, product, entry };
  };

  it("deleteInventoryEntries (single soft delete) leaves no orphan", async () => {
    const { entry } = await seedEntry("Shelf A", "Bolt A");
    await seedEmbedding("inventory", entry.id);

    await deleteInventoryEntries(ctx.db, [entry.id], TEST_ACTOR);

    expect(await embeddingDeletedAt(entry.id)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  it("bulkProcessInventoryEntries (delete-on-omit) leaves no orphan", async () => {
    const { location, entry } = await seedEntry("Shelf B", "Bolt B");
    await seedEmbedding("inventory", entry.id);

    // Empty batch omits the existing entry → it is soft-deleted.
    await bulkProcessInventoryEntries(ctx.db, location.id, [], TEST_ACTOR);

    expect(await embeddingDeletedAt(entry.id)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  it("reconcileLocationSession remove leaves no orphan", async () => {
    const { location, entry } = await seedEntry("Shelf C", "Bolt C");
    await seedEmbedding("inventory", entry.id);

    const { removedIds } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: location.id,
        expectedInventoryEntryIds: [entry.id],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [{ kind: "remove", inventoryEntryId: entry.id }],
      },
      TEST_ACTOR,
    );
    expect(removedIds).toEqual([entry.id]);

    expect(await embeddingDeletedAt(entry.id)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  it("bulkMoveInventoryEntries full-collapse (hard delete of source) leaves no orphan", async () => {
    // Source + target hold the SAME product, so a full move collapses the source
    // onto the target's existing row — the source row is HARD-deleted.
    const source = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Source Bin" }),
      TEST_ACTOR,
    );
    const target = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Target Bin" }),
      TEST_ACTOR,
    );
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Shared Bolt" }),
      TEST_ACTOR,
    );
    const sourceEntry = await createInventoryEntry(
      ctx.db,
      { productId: product.id, locationId: source.id, amount },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      { productId: product.id, locationId: target.id, amount },
      TEST_ACTOR,
    );
    await seedEmbedding("inventory", sourceEntry.id);

    await bulkMoveInventoryEntries(
      ctx.db,
      {
        sourceLocationId: source.id,
        targetLocationId: target.id,
        items: [{ inventoryEntryId: sourceEntry.id, quantity: amount }],
      },
      TEST_ACTOR,
    );

    // The source inventory row is hard-deleted; its embedding is deliberately
    // soft-deleted (excluded from search + orphan detection), never left live.
    expect(await embeddingDeletedAt(sourceEntry.id)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });
});
