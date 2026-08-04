import {
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import {
  entityEmbedding,
  inventoryEntry,
  task,
  taskDependency,
} from "~/server/db/schema";
import { deleteCookbook, upsertCookbook } from "~/server/repo/cookbook";
import { getDb } from "~/server/repo/database-helpers";
import { findOrphanedEntityEmbeddings } from "~/server/repo/entity-embedding";
import { createExpense, deleteExpenses } from "~/server/repo/expense";
import {
  findOrCreateIngredient,
  mergeIngredients,
} from "~/server/repo/ingredient";
import {
  bulkMoveInventoryEntries,
  bulkProcessInventoryEntries,
  createInventoryEntry,
  deleteInventoryEntries,
  reconcileLocationSession,
} from "~/server/repo/inventory";
import { createLocation } from "~/server/repo/location";
import { createMealWithEntityId, deleteMeals } from "~/server/repo/meal";
import { createProduct, mergeProducts } from "~/server/repo/product";
import { createProject, deleteProjects } from "~/server/repo/project";
import {
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTask, deleteTasks, updateTask } from "~/server/repo/task";

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

  const requireResolvedId = async (
    shortcode: string,
    entity: "inventory" | "location" | "product",
  ) => {
    const entityId = await resolveLiveShortcode(ctx.db, shortcode, entity);
    if (!entityId) throw new Error(`Failed to resolve ${entity} ${shortcode}`);
    return entityId;
  };

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
    const locationEntityId = unsafeLocationId(
      await requireResolvedId(location.id, "location"),
    );
    const productEntityId = unsafeProductId(
      await requireResolvedId(product.id, "product"),
    );
    const entry = await createInventoryEntry(
      ctx.db,
      { productId: productEntityId, locationId: locationEntityId, amount },
      TEST_ACTOR,
    );
    const entryEntityId = unsafeInventoryId(
      await requireResolvedId(entry.id, "inventory"),
    );
    return {
      location,
      locationEntityId,
      product,
      productEntityId,
      entry,
      entryEntityId,
    };
  };

  it("deleteInventoryEntries (single soft delete) leaves no orphan", async () => {
    const { entryEntityId } = await seedEntry("Shelf A", "Bolt A");
    await seedEmbedding("inventory", entryEntityId);

    await deleteInventoryEntries(ctx.db, [entryEntityId], TEST_ACTOR);

    expect(await embeddingDeletedAt(entryEntityId)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  it("bulkProcessInventoryEntries (delete-on-omit) leaves no orphan", async () => {
    const { locationEntityId, entryEntityId } = await seedEntry(
      "Shelf B",
      "Bolt B",
    );
    await seedEmbedding("inventory", entryEntityId);

    // Empty batch omits the existing entry → it is soft-deleted.
    await bulkProcessInventoryEntries(ctx.db, locationEntityId, [], TEST_ACTOR);

    expect(await embeddingDeletedAt(entryEntityId)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
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

    expect(await embeddingDeletedAt(entryEntityId)).not.toBeNull();
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
    const sourceEntityId = unsafeLocationId(
      await requireResolvedId(source.id, "location"),
    );
    const targetEntityId = unsafeLocationId(
      await requireResolvedId(target.id, "location"),
    );
    const productEntityId = unsafeProductId(
      await requireResolvedId(product.id, "product"),
    );
    const sourceEntry = await createInventoryEntry(
      ctx.db,
      { productId: productEntityId, locationId: sourceEntityId, amount },
      TEST_ACTOR,
    );
    await createInventoryEntry(
      ctx.db,
      { productId: productEntityId, locationId: targetEntityId, amount },
      TEST_ACTOR,
    );
    const sourceEntryEntityId = unsafeInventoryId(
      await requireResolvedId(sourceEntry.id, "inventory"),
    );
    await seedEmbedding("inventory", sourceEntryEntityId);

    await bulkMoveInventoryEntries(
      ctx.db,
      {
        sourceLocationId: sourceEntityId,
        targetLocationId: targetEntityId,
        items: [{ inventoryEntryId: sourceEntryEntityId, quantity: amount }],
      },
      TEST_ACTOR,
    );

    // The source inventory row is hard-deleted; its embedding is deliberately
    // soft-deleted (excluded from search + orphan detection), never left live.
    expect(await embeddingDeletedAt(sourceEntryEntityId)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });
});

// Same F1 regression guard as above, extended to the tracker entities
// (project/task/expense) — their delete paths cascade
// softDeleteEntityEmbeddingsTx exactly like inventory's.
describe("tracker removal cascades entity embeddings (no orphans)", () => {
  const ctx = withTestDb();

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

  const embeddingDeletedAt = async (
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
    )?.deletedAt;

  it("deleteProjects leaves no orphan", async () => {
    const { output: project, entityId: projectId } = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Embedding Cascade Project" },
      }),
      TEST_ACTOR,
    );
    await seedEmbedding("project", projectId);

    await deleteProjects(ctx.db, [project.id], TEST_ACTOR);

    expect(await embeddingDeletedAt("project", projectId)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  it("deleteTasks leaves no orphan", async () => {
    const { output: task, entityId: taskId } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: { name: "Embedding Cascade Task" },
      }),
      TEST_ACTOR,
    );
    await seedEmbedding("task", taskId);

    await deleteTasks(ctx.db, [task.id], TEST_ACTOR);

    expect(await embeddingDeletedAt("task", taskId)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  // task.parentTaskId one-level cascade: deleting a parent takes its live
  // subtasks with it (they have no independent existence — a checklist item
  // is represented via its parent). Same soft-delete/edge-cleanup/embedding
  // treatment as the explicitly-requested id.
  it("deleteTasks cascades to live subtasks (soft-deleted, edges cleaned, embeddings cleaned)", async () => {
    const { output: parentTask, entityId: parentTaskId } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: { name: "Cascade Parent", parentTaskId: null },
      }),
      TEST_ACTOR,
    );
    const { output: subtask, entityId: subtaskId } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: { name: "Cascade Subtask", parentTaskId: parentTask.id },
      }),
      TEST_ACTOR,
    );
    const { output: blocker } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: { name: "Cascade Blocker", parentTaskId: null },
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
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  // Cookbook and meal joined the searchable set later; their delete paths carry
  // the same in-transaction embedding cleanup obligation.
  it("deleteCookbook leaves no orphan", async () => {
    const { entityId: cookbookId } = await upsertCookbook(
      ctx.db,
      {
        name: "Embedding Cascade Cookbook",
        rawJson: [],
        sourceLabel: "cascade.epub",
      },
      TEST_ACTOR,
    );
    await seedEmbedding("cookbook", cookbookId);

    await deleteCookbook(ctx.db, cookbookId, TEST_ACTOR);

    expect(await embeddingDeletedAt("cookbook", cookbookId)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  it("deleteMeals leaves no orphan", async () => {
    const { entityId: mealId } = await createMealWithEntityId(
      ctx.db,
      { date: "2026-06-01", name: "Embedding Cascade Meal" },
      TEST_ACTOR,
    );
    await seedEmbedding("meal", mealId);

    await deleteMeals(ctx.db, [mealId], TEST_ACTOR);

    expect(await embeddingDeletedAt("meal", mealId)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  it("deleteExpenses leaves no orphan", async () => {
    const { output: expense, entityId: expenseId } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: { name: "Embedding Cascade Expense" },
      }),
      TEST_ACTOR,
    );
    await seedEmbedding("expense", expenseId);

    await deleteExpenses(ctx.db, [expense.id], TEST_ACTOR);

    expect(await embeddingDeletedAt("expense", expenseId)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  // mergeIngredients is the one removal path in the repo that HARD-deletes
  // its absorbed rows instead of soft-deleting them (see ingredient/merge.ts)
  // — easy to overlook the embedding-cleanup obligation because there's no
  // `deletedAt` write to hang it off of. The absorbed row's embedding still
  // must end up soft-deleted, same as a hard-deleted inventory row in the
  // full-collapse move case above.
  it("mergeIngredients leaves no orphan", async () => {
    const keeper = await findOrCreateIngredient(
      ctx.db,
      "Embedding Cascade Ingredient Keeper",
    );
    const alias = await findOrCreateIngredient(
      ctx.db,
      "Embedding Cascade Ingredient Alias",
    );
    await seedEmbedding("ingredient", alias.id);

    await mergeIngredients(ctx.db, keeper.id, [alias.id]);

    expect(await embeddingDeletedAt("ingredient", alias.id)).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });

  // A product merge removes TWO kinds of row: the merged-away products, and any
  // stock entry it absorbs into a survivor entry in the same location. Both are
  // searchable, so both owe an in-transaction cascade — and the inventory one is
  // the easy miss, because it is a soft-delete buried inside a fold rather than
  // the merge's own `finalizeMerge` call.
  it("mergeProducts leaves no orphan, for the product AND the absorbed stock row", async () => {
    const resolveId = async (
      shortcode: string,
      entity: "location" | "product",
    ) => {
      const entityId = await resolveLiveShortcode(ctx.db, shortcode, entity);
      if (!entityId)
        throw new Error(`Failed to resolve ${entity} ${shortcode}`);
      return entityId;
    };
    const amount = { value: 3, unit: "each" };

    const location = await createLocation(
      ctx.db,
      makeLocationInput({ name: "Merge Cascade Shelf" }),
      TEST_ACTOR,
    );
    const locationEntityId = unsafeLocationId(
      await resolveId(location.id, "location"),
    );
    const keeper = await createProduct(
      ctx.db,
      makeProductInput({ name: "Merge Cascade Keeper" }),
      TEST_ACTOR,
    );
    const loser = await createProduct(
      ctx.db,
      makeProductInput({ name: "Merge Cascade Loser" }),
      TEST_ACTOR,
    );
    const loserEntityId = unsafeProductId(await resolveId(loser.id, "product"));
    for (const productEntityId of [
      unsafeProductId(await resolveId(keeper.id, "product")),
      loserEntityId,
    ]) {
      await createInventoryEntry(
        ctx.db,
        { productId: productEntityId, locationId: locationEntityId, amount },
        TEST_ACTOR,
      );
    }
    const absorbedEntry = await getDb(ctx.db).query.inventoryEntry.findFirst({
      where: eq(inventoryEntry.productId, loserEntityId),
      columns: { id: true },
    });
    if (!absorbedEntry) throw new Error("Expected a loser inventory entry");

    await seedEmbedding("product", loserEntityId);
    await seedEmbedding("inventory", absorbedEntry.id);

    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      TEST_ACTOR,
    );

    expect(await embeddingDeletedAt("product", loserEntityId)).not.toBeNull();
    expect(
      await embeddingDeletedAt("inventory", absorbedEntry.id),
    ).not.toBeNull();
    expect(await findOrphanedEntityEmbeddings(ctx.db)).toHaveLength(0);
  });
});
