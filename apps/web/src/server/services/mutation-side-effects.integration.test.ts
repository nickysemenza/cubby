import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import type { SearchableEntity } from "@cubby/schemas/search";
import { testUserId } from "@cubby/schemas/testing";
import type { CreatableEntity, EntityOverrides } from "tooling/factories/build";
import { createEntity } from "tooling/factories/create";
import { fakerFromSeed, hashSeed } from "tooling/factories/faker";
import { buildKernelContext } from "tooling/scenarios/context";
import { TEST_USER_ID, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import type { Database } from "~/server/db";
import {
  getEntityEmbeddingDeletedAtForRef,
  seedEntityEmbedding,
} from "~/server/repo/entity-embedding";
import { createExpense } from "~/server/repo/expense/crud";
import { deleteProducts } from "~/server/repo/product/crud";
import { createProject, updateProject } from "~/server/repo/project/crud";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
  renameFixtureRaw,
} from "~/server/repo/repo.fixtures";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/repo/search-document";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { createTask } from "~/server/repo/task/crud";

import { getSemanticEmbeddingConfig } from "../semantic/config";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
  type MutationSideEffectEvent,
  type MutationSideEffectPorts,
} from "./mutation-side-effects";

/** Fan-out and projections run against the real database; publication is captured. */
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

const embeddingRefreshRefs = (tasks: readonly BackgroundTaskInput[]) =>
  tasks.flatMap((task) =>
    task.kind === "entity-embedding.refresh"
      ? [{ entityKind: task.entityKind, entityId: task.entityId }]
      : [],
  );

/** Publications that carry embedding refreshes (location AI work is separate). */
const embeddingWaves = (published: readonly BackgroundTaskInput[][]) =>
  published.filter((tasks) =>
    tasks.some((task) => task.kind === "entity-embedding.refresh"),
  );

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

  it("product update enqueues product and related inventory/task embedding refreshes", async () => {
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
    const { entityId: taskId } = await createTask(
      ctx.db,
      mock(taskCreateInput, {
        overrides: {
          name: "Maintain manifest tarp",
          subjectProductId: product.id,
          trade: "other",
        },
      }),
      ctx.actor,
    );

    const ports = capturingPorts();
    await runMutationSideEffects(
      ctx.db,
      {
        action: "updated",
        entity: { entity: "product", id: product.entityId },
        source: "test.product.update",
      },
      ports,
    );

    const refs = embeddingRefreshRefs(ports.published.flat());
    expect(refs).toEqual(
      expect.arrayContaining([
        { entityKind: "product", entityId: product.entityId },
        { entityKind: "inventory", entityId: inventory.entityId },
        { entityKind: "task", entityId: taskId },
      ]),
    );
  });

  it("project rename enqueues project and related task/expense embedding refreshes", async () => {
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
          name: "Manifest Tracker Expense",
          date: "2026-01-02",
          projectId: project.id,
          trade: "other",
        },
      }),
      ctx.actor,
    );

    // Tasks/expenses embed their project's name, so a rename must fan out
    // (see findTrackerEmbeddingRefsForProjects).
    // Expense is searchable but not embeddable (financial entity), so its
    // SearchDocument still refreshes but no `entity-embedding.refresh` task is
    // published for it — see `publishEmbeddingRefreshes`.
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

    const refs = embeddingRefreshRefs(ports.published.flat());
    expect(refs).toEqual(
      expect.arrayContaining([
        { entityKind: "project", entityId: projectId },
        { entityKind: "task", entityId: taskId },
      ]),
    );
    expect(refs).not.toContainEqual({
      entityKind: "expense",
      entityId: expenseId,
    });
  });

  it("bulk wave publishes exactly one entity-embedding task list for N entities", async () => {
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

    const ports = capturingPorts();
    await runMutationSideEffectsForEntities(
      ctx.db,
      entries.map((entry) => ({
        action: "created" as const,
        entity: { entity: "inventory" as const, id: entry.entityId },
        source: "test.embedding.bulk",
      })),
      ports,
    );

    // Three entities with no dependents must collapse into a single
    // publishTasks call (one wave-wide dispatch), not one per entity.
    expect(ports.published).toHaveLength(1);
    const refs = embeddingRefreshRefs(ports.published[0] ?? []);
    expect(refs).toEqual(
      expect.arrayContaining(
        entries.map((entry) => ({
          entityKind: "inventory",
          entityId: entry.entityId,
        })),
      ),
    );
    expect(refs).toHaveLength(3);
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
    expect(embeddingRefreshRefs(ports.published.flat())).toEqual(
      expect.arrayContaining([
        { entityKind: "product", entityId: tarp.id },
        { entityKind: "inventory", entityId: stock.id },
        { entityKind: "task", entityId: parent.id },
        { entityKind: "task", entityId: child.id },
        { entityKind: "wish", entityId: wish.id },
      ]),
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
    expect(embeddingRefreshRefs(ports.published.flat())).toEqual(
      expect.arrayContaining([
        { entityKind: "product", entityId: cover.id },
        { entityKind: "inventory", entityId: stock.id },
      ]),
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
    expect(embeddingRefreshRefs(quiet.published.flat())).toEqual(
      expect.arrayContaining([
        { entityKind: "location", entityId: bed.id },
        { entityKind: "planting", entityId: planting.id },
        { entityKind: "gardenEntry", entityId: entry.id },
      ]),
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

    expect(embeddingRefreshRefs(ports.published.flat())).toEqual(
      expect.arrayContaining([
        { entityKind: "plant", entityId: plant.id },
        { entityKind: "planting", entityId: planting.id },
      ]),
    );
  });

  it("a bulk wave of related edits publishes one deduplicated embedding wave", async () => {
    const seed = kernelSeeder(ctx.db);
    const place = await seed("location", { name: "Fanout garage" });
    const rope = await seed("product", { name: "Fanout rope" });
    const twine = await seed("product", { name: "Fanout twine" });
    const stock = await seed("inventory", {
      productId: rope.code,
      locationId: place.code,
      amount: { value: 1, unit: "each" },
    });
    const chore = await seed("task", {
      name: "Fanout coil chore",
      trade: "other",
      subjectProductId: twine.code,
    });

    const ports = capturingPorts();
    await runMutationSideEffectsForEntities(
      ctx.db,
      [
        ...[rope.id, twine.id].map((id): MutationSideEffectEvent => ({
          action: "updated",
          entity: { entity: "product", id },
          source: "product.bulkUpdate",
        })),
        // Edited itself and also a dependent of the first Product.
        {
          action: "updated",
          entity: { entity: "inventory", id: stock.id },
          source: "product.bulkUpdate",
        },
      ],
      ports,
    );

    const waves = embeddingWaves(ports.published);
    expect(waves).toHaveLength(1);
    const refs = embeddingRefreshRefs(waves[0] ?? []);
    expect(refs).toHaveLength(new Set(refs.map((ref) => ref.entityId)).size);
    expect(refs).toEqual(
      expect.arrayContaining([
        { entityKind: "product", entityId: rope.id },
        { entityKind: "product", entityId: twine.id },
        { entityKind: "inventory", entityId: stock.id },
        { entityKind: "task", entityId: chore.id },
      ]),
    );
  });

  it("projection: 'skip' leaves the search documents to the caller's transaction", async () => {
    const seed = kernelSeeder(ctx.db);
    const kit = await seed("product", { name: "Fanout kit" });
    await renameFixtureRaw(ctx.db, "product", kit.id, "Fanout bundle");

    const ports = capturingPorts();
    await runMutationSideEffects(
      ctx.db,
      {
        action: "updated",
        entity: { entity: "product", id: kit.id },
        source: "test.product.skip",
      },
      ports,
      { projection: "skip" },
    );

    expect(await semanticText(ctx.db, "product", kit.id)).toContain(
      "Fanout kit",
    );
    expect(embeddingRefreshRefs(ports.published.flat())).toContainEqual({
      entityKind: "product",
      entityId: kit.id,
    });
  });
});
