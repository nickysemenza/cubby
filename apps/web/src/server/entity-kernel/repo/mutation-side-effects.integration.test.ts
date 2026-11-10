import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import { projectCreateInput } from "@cubby/schemas/entities/project";
import { taskCreateInput } from "@cubby/schemas/entities/task";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import type { EntityRef } from "@cubby/schemas/identifiers";
import { expenseCreateInput } from "@cubby/schemas/project";
import type { SearchableEntity } from "@cubby/schemas/search";
import { testUserId } from "@cubby/schemas/testing";
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
import { createExpense } from "~/server/domains/expense/repo/crud";
import { deleteProducts } from "~/server/domains/product/repo/crud";
import {
  createProject,
  updateProject,
} from "~/server/domains/project/repo/crud";
import { createTask } from "~/server/domains/task/repo/crud";
import { recordChange } from "~/server/generic/changes/repo/change";
import {
  getEntityEmbeddingDeletedAtForRef,
  seedEntityEmbedding,
} from "~/server/generic/embedding/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/generic/search/repo/search-document";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  createProductFixture as createProduct,
  makeProductInput,
  renameFixtureRaw,
} from "~/server/testing/repo.fixtures";

import {
  registerLocationImageChange,
  type LocationImageChangePorts,
} from "./mutation-side-effects";

type MutationSideEffectEvent = {
  action: "created" | "updated" | "deleted";
  entity: EntityRef;
  source: string;
  locationImagesChanged?: boolean;
};

/** Capture only external AI intent; derived search publication uses its real Job. */
function capturingPorts(): LocationImageChangePorts & {
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

async function captureSideEffects(
  db: Database,
  event: MutationSideEffectEvent,
  ports = capturingPorts(),
) {
  await recordChange(db, { kind: "source", categories: [event.entity.entity] });
  if (
    event.entity.entity === "location" &&
    event.locationImagesChanged &&
    event.action !== "deleted"
  )
    await registerLocationImageChange(
      db,
      { locationId: event.entity.id },
      ports,
    );
}

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
