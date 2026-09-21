import { parseEntityId } from "@cubby/schemas/identifiers";
/**
 * The embedding-cascade invariant: a removal must soft-delete the removed row's
 * `EntityEmbedding` in the same transaction. A live embedding pointing at a
 * removed id is permanent damage — soft deletes aren't restorable, semantic
 * search keeps returning a result that renders blank, and in the hard-delete
 * case the row dangles with no FK.
 *
 * It used to prove that each of 21 hand-copied `softDeleteEntityEmbeddingsTx`
 * calls was present — one real-DB case per call site, each asserting somebody
 * remembered. That is structural now: `cascadeRemoval` derives the cascade from
 * `entity` (a type predicate over the searchable roster, so it can't be
 * disabled or mis-aimed) and is the only thing that can mint a removal's
 * `delete` audit entry, so a path that skips the cascade can't write its audit
 * trail either — a compile error, not a test failure. `removeEntity` owns the
 * whole write half above it.
 *
 * Four things remain provable only here:
 *
 *  - **Wiring** — that an entrypoint reaches the shared machinery at all. The
 *    table-driven case, one row per migrated entity.
 *  - **The paths that deliberately keep hand-written removal statements** — the
 *    four inventory cases. Reconcile and the bulk diffs interleave their own
 *    statements with the borrowed tail, and nothing structural pins where that
 *    tail sits relative to the slot planner.
 *  - **Merges** — a separate path (`finalizeMerge`); `mergeProducts` is the only
 *    coverage of the absorbed-stock cascade and of its ordering against UPC
 *    adoption.
 *  - **Expansion semantics** — `deleteTasks` widens its own id set to live
 *    subtasks, and the cascade must run over the widened set. No type says so.
 *
 * Every case below asserts directly against `EntityEmbedding` that the
 * specific row the cascade should have touched was soft-deleted in the same
 * transaction — the direct-table form of "no orphan," rather than routing
 * through a detector.
 */
import { taskCreateInput } from "@cubby/schemas/project";
import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq } from "drizzle-orm";
import type { TestDbContext } from "tooling/test-setup";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import {
  entityEmbedding,
  inventoryEntry,
  task,
  taskDependency,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import {
  createInventoryEntry,
  deleteInventoryEntries,
  reconcileLocationSession,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createProduct, mergeProducts } from "~/server/repo/product";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTask, deleteTasks, updateTask } from "~/server/repo/task";

const amount = { value: 3, unit: "each" };

/**
 * Bound to the holder rather than to a `Database`: `ctx.db` is only populated in
 * `withTestDb`'s `beforeEach`, so every read of it has to happen at call time.
 */
const embeddingProbes = (ctx: TestDbContext) => {
  const resolveId = async (
    shortcode: string,
    entity: "inventory" | "location" | "product",
  ) => {
    const id = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!id) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return id;
  };

  return {
    resolveId,

    seedEmbedding: (entityType: SearchableEntity, entityId: string) =>
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
        }),

    embeddingDeletedAt: async (
      entityType: SearchableEntity,
      entityId: string,
    ) =>
      (
        await getDb(ctx.db).query.entityEmbedding.findFirst({
          where: and(
            eq(entityEmbedding.entityType, entityType),
            eq(entityEmbedding.entityId, entityId),
          ),
          columns: { deletedAt: true },
        })
      )?.deletedAt,

    /** Both identities: the shortcode repo writes take, and the entity id. */
    seedLocation: async (name: string) => {
      const row = await createLocation(
        ctx.db,
        makeLocationInput({ name }),
        TEST_ACTOR,
      );
      return {
        shortcode: row.id,
        id: parseEntityId("location", await resolveId(row.id, "location")),
      };
    },

    seedProduct: async (name: string) => {
      const row = await createProduct(
        ctx.db,
        makeProductInput({ name }),
        TEST_ACTOR,
      );
      return {
        shortcode: row.id,
        id: parseEntityId("product", await resolveId(row.id, "product")),
      };
    },
  };
};

describe("inventory removal cascades entity embeddings (no orphans)", () => {
  const ctx = withTestDb();
  const {
    seedEmbedding,
    embeddingDeletedAt,
    resolveId,
    seedLocation,
    seedProduct,
  } = embeddingProbes(ctx);

  const seedEntry = async (locationName: string, productName: string) => {
    const locationEntityId = (await seedLocation(locationName)).id;
    const entry = await createInventoryEntry(
      ctx.db,
      {
        productId: (await seedProduct(productName)).id,
        locationId: locationEntityId,
        amount,
      },
      TEST_ACTOR,
    );
    const entryEntityId = parseEntityId(
      "inventory",
      await resolveId(entry.id, "inventory"),
    );
    return { locationEntityId, entry, entryEntityId };
  };

  it("deleteInventoryEntries (single soft delete) leaves no orphan", async () => {
    const { entryEntityId } = await seedEntry("Shelf A", "Bolt A");
    await seedEmbedding("inventory", entryEntityId);

    await deleteInventoryEntries(ctx.db, [entryEntityId], TEST_ACTOR);

    expect(await embeddingDeletedAt("inventory", entryEntityId)).not.toBeNull();
  });

  it("reconcileLocationSession remove leaves no orphan", async () => {
    const { locationEntityId, entry, entryEntityId } = await seedEntry(
      "Shelf C",
      "Bolt C",
    );
    await seedEmbedding("inventory", entryEntityId);

    const { removedIds } = await reconcileLocationSession(
      ctx.db,
      {
        locationId: locationEntityId,
        expectedInventoryEntryIds: [entryEntityId],
        snapshotUpdatedAt: entry.updatedAt,
        resolutions: [{ kind: "remove", inventoryEntryId: entryEntityId }],
      },
      TEST_ACTOR,
    );
    expect(removedIds).toEqual([entryEntityId]);

    expect(await embeddingDeletedAt("inventory", entryEntityId)).not.toBeNull();
  });
});

describe("removal entrypoints reach the shared cascade (no orphans)", () => {
  const ctx = withTestDb();
  const { seedEmbedding, embeddingDeletedAt, seedLocation, seedProduct } =
    embeddingProbes(ctx);

  // Behavior, not wiring: `deleteTasks` widens its own id set to the live
  // subtasks (a checklist item has no independent existence), and the
  // dependency-edge cleanup, the soft delete, and the cascade must all run over
  // the widened set rather than the requested ids.
  it("deleteTasks cascades to live subtasks (soft-deleted, edges cleaned, embeddings cleaned)", async () => {
    const { output: parentTask, entityId: parentTaskId } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: {
          name: "Cascade Parent",
          parentTaskId: null,
          trade: "other",
        },
      }),
      TEST_ACTOR,
    );
    const { output: subtask, entityId: subtaskId } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: {
          name: "Cascade Subtask",
          parentTaskId: parentTask.id,
          trade: "other",
        },
      }),
      TEST_ACTOR,
    );
    const { output: blocker } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: {
          name: "Cascade Blocker",
          parentTaskId: null,
          trade: "other",
        },
      }),
      TEST_ACTOR,
    );
    await updateTask(
      ctx.db,
      subtask.id,
      { blockedByIds: [blocker.id] },
      TEST_ACTOR,
    );
    await seedEmbedding("task", parentTaskId);
    await seedEmbedding("task", subtaskId);

    await deleteTasks(ctx.db, [parentTask.id], TEST_ACTOR);

    const parentRow = await getDb(ctx.db).query.task.findFirst({
      where: eq(task.id, parentTaskId),
    });
    const subtaskRow = await getDb(ctx.db).query.task.findFirst({
      where: eq(task.id, subtaskId),
    });
    expect(parentRow?.deletedAt).not.toBeNull();
    expect(subtaskRow?.deletedAt).not.toBeNull();

    const remainingEdges = await getDb(ctx.db).query.taskDependency.findMany({
      where: eq(taskDependency.taskId, subtaskId),
    });
    expect(remainingEdges).toHaveLength(0);

    expect(await embeddingDeletedAt("task", parentTaskId)).not.toBeNull();
    expect(await embeddingDeletedAt("task", subtaskId)).not.toBeNull();
  });

  // mergeIngredients is the one removal path in the repo that HARD-deletes its
  // absorbed rows instead of soft-deleting them (see ingredient/merge.ts) —
  // easy to overlook the embedding-cleanup obligation because there is no
  // `deletedAt` write to hang it off of.

  // A product merge removes TWO kinds of row: the merged-away products, and any
  // stock entry it absorbs into a survivor entry in the same location. Both are
  // searchable, so both owe an in-transaction cascade — and the inventory one is
  // the easy miss, because it is a soft-delete buried inside a fold rather than
  // the merge's own `finalizeMerge` call.
  it("mergeProducts leaves no orphan, for the product AND the absorbed stock row", async () => {
    const location = await seedLocation("Merge Cascade Shelf");
    const keeper = await seedProduct("Merge Cascade Keeper");
    const loser = await seedProduct("Merge Cascade Loser");
    for (const productId of [keeper.id, loser.id]) {
      await createInventoryEntry(
        ctx.db,
        { productId, locationId: location.id, amount },
        TEST_ACTOR,
      );
    }
    const absorbedEntry = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.productId, loser.id),
      columns: { id: true },
    });
    if (!absorbedEntry) throw new Error("Expected a loser inventory entry");

    await seedEmbedding("product", loser.id);
    await seedEmbedding("inventory", absorbedEntry.id);

    await mergeProducts(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      TEST_ACTOR,
    );

    expect(await embeddingDeletedAt("product", loser.id)).not.toBeNull();
    expect(
      await embeddingDeletedAt("inventory", absorbedEntry.id),
    ).not.toBeNull();
  });
});
