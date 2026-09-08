import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import {
  getEntityEmbeddingDeletedAtForRef,
  upsertEntityEmbedding,
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
import { createTask } from "~/server/repo/task";

import {
  getBackgroundBatchDetail,
  listBackgroundBatches,
} from "../repo/background-jobs";
import { getSemanticEmbeddingConfig } from "../semantic/config";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "./mutation-side-effects";

const batchMetadataSchema = z.object({ source: z.string().optional() });
const batchSource = <Metadata>(metadata: Metadata): string | undefined => {
  const parsed = batchMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data.source : undefined;
};

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
        },
      }),
      ctx.actor,
    );

    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entity: "product", id: product.entityId },
      source: "test.product.update",
    });

    const batches = await listBackgroundBatches(ctx.db, 20);
    const embeddingBatches = batches.filter(
      (batch) =>
        batch.kind === "entity-embedding.refresh" &&
        batchSource(batch.metadata) === "test.product.update",
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
          payload: { entityType: "product", entityId: product.entityId },
        }),
        expect.objectContaining({
          payload: { entityType: "inventory", entityId: inventory.entityId },
        }),
        expect.objectContaining({
          payload: { entityType: "task", entityId: taskId },
        }),
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
        overrides: { name: "Manifest Tracker Task", projectId: project.id },
      }),
      ctx.actor,
    );
    const { entityId: expenseId } = await createExpense(
      ctx.db,
      mock(expenseCreateInput, {
        overrides: {
          name: "Manifest Tracker Expense",
          projectId: project.id,
        },
      }),
      ctx.actor,
    );

    // Tasks/expenses embed their project's name, so a rename must fan out
    // (see refreshTrackerEmbeddingsForProject / findTrackerEmbeddingRefsForProjects).
    await updateProject(
      ctx.db,
      project.id,
      { name: "Manifest Tracker Project Renamed" },
      ctx.actor,
    );
    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entity: "project", id: projectId },
      source: "test.project.rename",
    });

    const batches = await listBackgroundBatches(ctx.db, 20);
    const embeddingBatches = batches.filter(
      (batch) =>
        batch.kind === "entity-embedding.refresh" &&
        batchSource(batch.metadata) === "test.project.rename",
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
          payload: { entityType: "project", entityId: projectId },
        }),
        expect.objectContaining({
          payload: { entityType: "task", entityId: taskId },
        }),
        expect.objectContaining({
          payload: { entityType: "expense", entityId: expenseId },
        }),
      ]),
    );
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
        entity: { entity: "inventory" as const, id: entry.entityId },
        source: "test.inventory.bulk",
      })),
    );

    const batches = await listBackgroundBatches(ctx.db, 50);
    const valuationBatches = batches.filter(
      (batch) =>
        batch.kind === "location-valuation.recompute" &&
        batchSource(batch.metadata) === "test.inventory.bulk",
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
        entity: { entity: "inventory" as const, id: entry.entityId },
        source: "test.embedding.bulk",
      })),
    );

    const batches = await listBackgroundBatches(ctx.db, 50);
    const embeddingBatches = batches.filter(
      (batch) =>
        batch.kind === "entity-embedding.refresh" &&
        batchSource(batch.metadata) === "test.embedding.bulk",
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
            entityId: entry.entityId,
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
      entityId: product.entityId,
      embeddingText: "product: Manifest deleted embedding",
      config,
      embedding: Array.from({ length: config.dimensions }, () => 0),
    });

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
