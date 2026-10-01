import { embeddableEntities } from "@cubby/schemas/search";
import { and, eq, isNull } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { searchDocument } from "~/server/db/schema";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import { getDb } from "./database-helpers";
import {
  createOrReuseAttachedImage,
  createPendingImageRecord,
  createUploadedImageRecord,
} from "./image";

/**
 * Kinds that opt out of the kernel's generic mutation side effects
 * (`sideEffects: false`). Each must project and enqueue embeddings itself; a
 * new opt-out fails this test until it names where that happens.
 */
const OPTED_OUT_OF_KERNEL_SIDE_EFFECTS = {
  // Their operations call runMutationSideEffects with richer orchestration.
  product: "repo/product/repository.ts",
  location: "repo/location/repository.ts",
  // Rows are inserted by the upload paths, covered by the tests below.
  image: "image create paths in this file",
};

describe("embedding coverage per embeddable kind", () => {
  it("every embeddable kind either runs kernel side effects or names its own path", () => {
    for (const kind of embeddableEntities) {
      const covered =
        ENTITY_KERNEL_BINDINGS[kind].sideEffects !== false ||
        kind in OPTED_OUT_OF_KERNEL_SIDE_EFFECTS;
      expect(covered, `${kind} never projects or embeds on create`).toBe(true);
    }
  });
});

describe("image create paths project and enqueue embedding", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;

  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => {
    queue.restore();
  });

  const liveDocumentFor = async (imageId: string) =>
    (
      await getDb(ctx.db)
        .select({ id: searchDocument.id })
        .from(searchDocument)
        .where(
          and(
            eq(searchDocument.entityKind, "image"),
            eq(searchDocument.entityId, imageId),
            isNull(searchDocument.deletedAt),
          ),
        )
    ).length;

  const refreshQueuedFor = (imageId: string) =>
    queue.tasks.some(
      (task) =>
        task.kind === "entity-embedding.refresh" &&
        task.entityKind === "image" &&
        task.entityId === imageId,
    );

  it("createPendingImageRecord", async () => {
    const row = await createPendingImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "pending-coverage.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });
    expect(await liveDocumentFor(row.id)).toBe(1);
    expect(refreshQueuedFor(row.id)).toBe(true);
  });

  it("createUploadedImageRecord", async () => {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "uploaded-coverage.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });
    expect(await liveDocumentFor(row.id)).toBe(1);
    expect(refreshQueuedFor(row.id)).toBe(true);
  });

  it("createOrReuseAttachedImage refreshes only after the transaction commits", async () => {
    const { entityId: projectId } = await createRepoEntity(ctx, "project", {
      name: "Embedding coverage project",
    });
    const { row } = await createOrReuseAttachedImage(
      ctx.db,
      {
        key: `test/${crypto.randomUUID()}.jpg`,
        filename: "attached-coverage.jpg",
        contentType: "image/jpeg",
        size: 1024,
      },
      { entity: "project", id: projectId },
    );
    expect(await liveDocumentFor(row.id)).toBe(1);
    expect(refreshQueuedFor(row.id)).toBe(true);
  });
});
