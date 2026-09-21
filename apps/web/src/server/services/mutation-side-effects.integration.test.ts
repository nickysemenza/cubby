import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";
import {
  getEntityEmbeddingDeletedAtForRef,
  seedEntityEmbedding,
} from "~/server/repo/entity-embedding";
import { createExpense } from "~/server/repo/expense";
import { deleteProducts } from "~/server/repo/product";
import { createProject, updateProject } from "~/server/repo/project";
import {
  createInventoryFixture as createInventoryEntry,
  createLocationFixture as createLocation,
  createProductFixture as createProduct,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/repo/search-document";
import { createTask } from "~/server/repo/task";

import { getSemanticEmbeddingConfig } from "../semantic/config";
import {
  productionMutationSideEffectPorts,
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
  type MutationSideEffectPorts,
} from "./mutation-side-effects";

/**
 * Real find-embedding-refs and refreshSearchDocuments ports (so embedding
 * fan-out still reads the actual DB), while publishTasks is captured in-memory
 * instead of hitting the queue.
 */
function capturingPorts(): MutationSideEffectPorts & {
  published: BackgroundTaskInput[][];
} {
  const published: BackgroundTaskInput[][] = [];
  return {
    ...productionMutationSideEffectPorts,
    published,
    publishTasks: async (_db, tasks) => {
      published.push([...tasks]);
    },
  };
}

const embeddingRefreshRefs = (tasks: readonly BackgroundTaskInput[]) =>
  tasks.flatMap((task) =>
    task.kind === "entity-embedding.refresh"
      ? [{ entityType: task.entityType, entityId: task.entityId }]
      : [],
  );

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
        { entityType: "product", entityId: product.entityId },
        { entityType: "inventory", entityId: inventory.entityId },
        { entityType: "task", entityId: taskId },
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
    // (see refreshTrackerEmbeddingsForProject / findTrackerEmbeddingRefsForProjects).
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
        { entityType: "project", entityId: projectId },
        { entityType: "task", entityId: taskId },
      ]),
    );
    expect(refs).not.toContainEqual({
      entityType: "expense",
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

    // Three entities whose only handler is refreshOwnEmbedding must collapse
    // into a single publishTasks call (one wave-wide dispatch), not one per entity.
    expect(ports.published).toHaveLength(1);
    const refs = embeddingRefreshRefs(ports.published[0] ?? []);
    expect(refs).toEqual(
      expect.arrayContaining(
        entries.map((entry) => ({
          entityType: "inventory",
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
      entityType: "product",
      entityId: product.entityId,
    });
    expect(deletedAt).toBeInstanceOf(Date);
  });
});
