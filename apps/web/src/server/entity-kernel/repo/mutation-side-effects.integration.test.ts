import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import type { SearchableEntity } from "@cubby/schemas/search";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import type { CreatableEntity, EntityOverrides } from "tooling/factories/build";
import { createEntity } from "tooling/factories/create";
import { fakerFromSeed, hashSeed } from "tooling/factories/faker";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  drainDerivedRefreshFrontier,
  captureBackgroundQueue,
} from "~/server/testing/background-queue";
let backgroundQueue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  backgroundQueue = captureBackgroundQueue();
});
afterEach(() => backgroundQueue.restore());

import { mock } from "~/lib/test/mock-schema";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { plant as plantTable, task } from "~/server/db/schema";
import { createExpense } from "~/server/domains/expense/repo/crud";
import { deleteProducts } from "~/server/domains/product/repo/crud";
import {
  createProject,
  updateProject,
} from "~/server/domains/project/repo/crud";
import { createTask } from "~/server/domains/task/repo/crud";
import { executeEntity } from "~/server/entity-kernel";
import {
  getEntityEmbeddingDeletedAtForRef,
  seedEntityEmbedding,
} from "~/server/generic/embedding/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/generic/search/repo/search-document";
import { refreshSearchDocuments } from "~/server/generic/search/repo/search-document";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createProductFixture as createProduct,
  makeProductInput,
  renameFixtureRaw,
} from "~/server/testing/repo.fixtures";

import {
  runMutationSideEffects as captureSideEffects,
  type MutationSideEffectEvent,
  type MutationSideEffectPorts,
} from "./mutation-side-effects";

/** Capture only external AI intent; derived search publication uses its real Job. */
function capturingPorts(): MutationSideEffectPorts & {
  published: BackgroundTaskInput[][];
} {
  const published: BackgroundTaskInput[][] = [];
  return {
    published,
    publishTasks: async (_db, tasks) => {
      published.push([...tasks]);
    },
  };
}

const drain = (db: Database) => drainDerivedRefreshFrontier(db);

async function runMutationSideEffects(
  db: Database,
  event: MutationSideEffectEvent,
  ports = capturingPorts(),
) {
  await captureSideEffects(db, event, ports);
  await drain(db);
}
/**
 * Seeds through the entity kernel (the browser's write path) and returns the
 * private id that side-effect events carry.
 */
function kernelSeeder(db: Database) {
  const faker = fakerFromSeed(hashSeed("mutation-side-effects"));
  const context = buildKernelContext(db, testUserId(TEST_USER_ID));
  return async <E extends CreatableEntity & ShortcodeEntity>(
    entity: E,
    overrides: EntityOverrides<E>,
  ) => {
    const created = await createEntity(context, entity, overrides, { faker });
    await drain(db);
    const id = await resolveLiveShortcode(db, created.id, entity);
    if (!id) throw new Error(`${entity} ${created.id} was not created`);
    return { code: created.id, id };
  };
}

const semanticText = async (
  db: Database,
  entityKind: SearchableEntity,
  entityId: string,
) =>
  (await getSearchDocumentEmbeddingText(db, entityKind, entityId))
    ?.embeddingText ?? "";

describe("mutation side effects integration", () => {
  const ctx = withTestDb();

  it("project rename refreshes Task and Expense search projections in the background", async () => {
    const { output: project, entityId: projectId } = await createProject(
      ctx.db,
      mock(projectCreateInput, {
        overrides: { name: "Manifest Tracker Project" },
      }),
      ctx.actor,
    );
    const { entityId: taskId } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: {
          name: "Manifest Tracker Task",
          projectId: project.id,
          trade: "other",
        },
      }),
      ctx.actor,
    );
    const { entityId: expenseId } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: {
          lineKind: "principal",
          name: "Manifest Tracker Expense",
          date: "2026-01-02",
          projectId: project.id,
          trade: "other",
        },
      }),
      ctx.actor,
    );

    // Financial entities refresh search text without generating embeddings.
    await updateProject(
      ctx.db,
      project.id,
      { name: "Manifest Tracker Project Renamed" },
      ctx.actor,
    );
    const ports = capturingPorts();
    await runMutationSideEffects(
      ctx.db,
      {
        action: "updated",
        entity: { entity: "project", id: projectId },
        source: "test.project.rename",
      },
      ports,
    );

    expect(await semanticText(ctx.db, "task", taskId)).toContain(
      "Manifest Tracker Project Renamed",
    );
    expect(await semanticText(ctx.db, "expense", expenseId)).toContain(
      "Manifest Tracker Project Renamed",
    );
  });

  it("repo delete soft-deletes the entity's search embedding", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({ name: "Manifest deleted embedding" }),
      ctx.actor,
    );
    const config = getSemanticEmbeddingConfig();
    // `seedEntityEmbedding` writes only against a live `SearchDocument` whose
    // `semanticText` matches, so project the document first and seed from it.
    await refreshSearchDocument(ctx.db, "product", product.entityId);
    const text = await getSearchDocumentEmbeddingText(
      ctx.db,
      "product",
      product.entityId,
    );
    if (!text) throw new Error("product search document must exist");
    await seedEntityEmbedding(ctx.db, { ...text, config });

    // Embedding cleanup lives in the repo delete cascade (not the mutation
    // side-effect), so it covers EVERY delete caller — including direct repo
    // deletes that skip runMutationSideEffects.
    await deleteProducts(ctx.db, [product.entityId], ctx.actor);

    const deletedAt = await getEntityEmbeddingDeletedAtForRef(ctx.db, {
      entityKind: "product",
      entityId: product.entityId,
    });
    expect(deletedAt).toBeInstanceOf(Date);
  });

  it("a product rename rewrites its inherited Task, Inventory, and Wish projections", async () => {
    const seed = kernelSeeder(ctx.db);
    const place = await seed("location", { name: "Fanout shed" });
    const tarp = await seed("product", { name: "Fanout tarp" });
    const stock = await seed("inventory", {
      productId: tarp.code,
      locationId: place.code,
      amount: { value: 1, unit: "each" },
    });
    const parent = await seed("task", {
      name: "Fanout parent chore",
      trade: "other",
      subjectProductId: tarp.code,
    });
    // No subject of its own: it inherits the parent's subject Product.
    const child = await seed("task", {
      name: "Fanout child chore",
      trade: "other",
      parentTaskId: parent.code,
    });
    const wish = await seed("wish", {
      name: "Fanout shade wish",
      candidateProductIds: [tarp.code],
    });
    for (const [kind, id] of [
      ["inventory", stock.id],
      ["task", child.id],
      ["wish", wish.id],
    ] as const) {
      expect(await semanticText(ctx.db, kind, id)).toContain("Fanout tarp");
    }

    await renameFixtureRaw(ctx.db, "product", tarp.id, "Fanout awning");
    const ports = capturingPorts();
    await runMutationSideEffects(
      ctx.db,
      {
        action: "updated",
        entity: { entity: "product", id: tarp.id },
        source: "test.product.rename",
      },
      ports,
    );

    for (const [kind, id] of [
      ["product", tarp.id],
      ["inventory", stock.id],
      ["task", parent.id],
      ["task", child.id],
      ["wish", wish.id],
    ] as const) {
      const text = await semanticText(ctx.db, kind, id);
      expect(text).toContain("Fanout awning");
      expect(text).not.toContain("Fanout tarp");
    }
  });

  it("a task change reaches the search projection of every inheriting descendant", async () => {
    const seed = kernelSeeder(ctx.db);
    const tarp = await seed("product", { name: "Lineage tarp" });
    const awning = await seed("product", { name: "Lineage awning" });
    const top = await seed("task", {
      name: "Lineage top chore",
      trade: "other",
      subjectProductId: tarp.code,
    });
    const middle = await seed("task", {
      name: "Lineage middle chore",
      trade: "other",
      parentTaskId: top.code,
    });
    // Two levels down, which writes no longer create (one subtask level)
    // but older data holds: it inherits the top task's subject.
    const bottom = await insertWithShortcode(ctx.db, "task", {
      name: "Lineage bottom chore",
      trade: "other",
      parentTaskId: middle.id as never,
    });

    await getDb(ctx.db)
      .update(task)
      .set({ subjectProductId: awning.id as never })
      .where(eq(task.id, top.id as never));
    await runMutationSideEffects(
      ctx.db,
      {
        action: "updated",
        entity: { entity: "task", id: top.id },
        source: "test.task.subject",
      },
      capturingPorts(),
    );

    const text = await semanticText(ctx.db, "task", bottom.id);
    expect(text).toContain("Lineage awning");
    expect(text).not.toContain("Lineage tarp");
  });

  it("deleting a task refreshes a surviving descendant that inherited through it", async () => {
    const seed = kernelSeeder(ctx.db);
    const tarp = await seed("product", { name: "Orphan tarp" });
    const top = await seed("task", {
      name: "Orphan top chore",
      trade: "other",
      subjectProductId: tarp.code,
    });
    const middle = await seed("task", {
      name: "Orphan middle chore",
      trade: "other",
      parentTaskId: top.code,
    });
    // Older data nests below the one-level delete cascade.
    const bottom = await insertWithShortcode(ctx.db, "task", {
      name: "Orphan bottom chore",
      trade: "other",
      parentTaskId: middle.id as never,
    });
    await refreshSearchDocuments(ctx.db, [
      { entityKind: "task", entityId: bottom.id },
    ]);
    expect(await semanticText(ctx.db, "task", bottom.id)).toContain(
      "Orphan tarp",
    );

    await executeEntity(buildKernelContext(ctx.db, testUserId(TEST_USER_ID)), {
      action: "delete",
      entity: "task",
      ids: [top.code],
    });
    await drain(ctx.db);

    expect(await semanticText(ctx.db, "task", bottom.id)).not.toContain(
      "Orphan tarp",
    );
  });

  it("a parent category rename reaches descendant Products and their Inventory", async () => {
    const seed = kernelSeeder(ctx.db);
    const root = await seed("productCategory", { name: "Fanout outdoor" });
    const leaf = await seed("productCategory", {
      name: "Fanout covers",
      parentId: root.code,
    });
    const place = await seed("location", { name: "Fanout porch" });
    const cover = await seed("product", {
      name: "Fanout cover",
      categoryId: leaf.code,
    });
    const stock = await seed("inventory", {
      productId: cover.code,
      locationId: place.code,
      amount: { value: 1, unit: "each" },
    });

    // Search text carries the leaf category's name.
    await renameFixtureRaw(ctx.db, "productCategory", leaf.id, "Fanout tarps");
    await runMutationSideEffects(
      ctx.db,
      {
        action: "updated",
        entity: { entity: "productCategory", id: leaf.id },
        source: "test.category.rename",
      },
      capturingPorts(),
    );
    for (const [kind, id] of [
      ["product", cover.id],
      ["inventory", stock.id],
    ] as const)
      expect(await semanticText(ctx.db, kind, id)).toContain("Fanout tarps");

    // A root edit still reaches every descendant Product and its Inventory.
    const ports = capturingPorts();
    await runMutationSideEffects(
      ctx.db,
      {
        action: "updated",
        entity: { entity: "productCategory", id: root.id },
        source: "test.category.rename",
      },
      ports,
    );
  });

  it("a location rename reaches its Plantings and Garden entries and gates AI on images", async () => {
    const seed = kernelSeeder(ctx.db);
    const bed = await seed("location", { name: "Fanout bed" });
    const basil = await seed("plant", { name: "Fanout basil" });
    const planting = await seed("planting", {
      plantId: basil.code,
      locationId: bed.code,
    });
    const entry = await seed("gardenEntry", {
      locationId: bed.code,
      plantingIds: [planting.code],
    });
    const rename = (
      locationImagesChanged: boolean,
    ): MutationSideEffectEvent => ({
      action: "updated",
      entity: { entity: "location", id: bed.id },
      source: "test.location.rename",
      locationImagesChanged,
    });

    await renameFixtureRaw(ctx.db, "location", bed.id, "Fanout raised bed");
    const quiet = capturingPorts();
    await runMutationSideEffects(ctx.db, rename(false), quiet);

    expect(await semanticText(ctx.db, "gardenEntry", entry.id)).toContain(
      "Fanout raised bed",
    );
    expect(quiet.published.flat().map((task) => task.kind)).not.toContain(
      "location-ai.description.refresh",
    );

    const withImages = capturingPorts();
    await runMutationSideEffects(ctx.db, rename(true), withImages);
    expect(withImages.published.flat().map((task) => task.kind)).toEqual(
      expect.arrayContaining([
        "location-ai.description.refresh",
        "location-ai.inventory.refresh",
      ]),
    );
  });

  it("a plant rename reaches its Plantings", async () => {
    const seed = kernelSeeder(ctx.db);
    const bed = await seed("location", { name: "Fanout plot" });
    const plant = await seed("plant", { name: "Fanout thyme" });
    const planting = await seed("planting", {
      plantId: plant.code,
      locationId: bed.code,
    });
    await getDb(ctx.db)
      .update(plantTable)
      .set({ name: "Fanout lemon thyme" })
      .where(eq(plantTable.id, plant.id));
    const ports = capturingPorts();
    await runMutationSideEffects(
      ctx.db,
      {
        action: "updated",
        entity: { entity: "plant", id: plant.id },
        source: "test.plant.rename",
      },
      ports,
    );
    expect(await semanticText(ctx.db, "planting", planting.id)).toContain(
      "Fanout lemon thyme",
    );
  });

  it("leaves derived projections unchanged until the background wave runs", async () => {
    const seed = kernelSeeder(ctx.db);
    const kit = await seed("product", { name: "Fanout kit" });
    await renameFixtureRaw(ctx.db, "product", kit.id, "Fanout bundle");

    const ports = capturingPorts();
    await captureSideEffects(
      ctx.db,
      {
        action: "updated",
        entity: { entity: "product", id: kit.id },
        source: "test.product.skip",
      },
      ports,
    );

    expect(await semanticText(ctx.db, "product", kit.id)).toContain(
      "Fanout kit",
    );
    await drain(ctx.db);
    expect(await semanticText(ctx.db, "product", kit.id)).toContain(
      "Fanout bundle",
    );
  });
});
