import { and, eq, isNull } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { searchDocument, job } from "~/server/db/schema";
import {
  captureBackgroundQueue,
  drainDerivedRefreshFrontier,
} from "~/server/testing/background-queue";

import {
  createOrReuseAttachedImage,
  createPendingImageRecord,
  createUploadedImageRecord,
} from "./image";

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

  const searchRefreshQueued = async () =>
    (
      await getDb(ctx.db)
        .select()
        .from(job)
        .where(and(eq(job.key, "refresh:search"), eq(job.state, "queued")))
        .limit(1)
    ).length > 0;

  it("createPendingImageRecord", async () => {
    const row = await createPendingImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "pending-coverage.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });
    expect(await liveDocumentFor(row.id)).toBe(0);
    expect(await searchRefreshQueued()).toBe(true);
    await drainDerivedRefreshFrontier(ctx.db);
    expect(await liveDocumentFor(row.id)).toBe(1);
  });

  it("createUploadedImageRecord", async () => {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `test/${crypto.randomUUID()}.jpg`,
      filename: "uploaded-coverage.jpg",
      contentType: "image/jpeg",
      size: 1024,
    });
    expect(await liveDocumentFor(row.id)).toBe(0);
    expect(await searchRefreshQueued()).toBe(true);
    await drainDerivedRefreshFrontier(ctx.db);
    expect(await liveDocumentFor(row.id)).toBe(1);
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
    expect(await liveDocumentFor(row.id)).toBe(0);
    expect(await searchRefreshQueued()).toBe(true);
    await drainDerivedRefreshFrontier(ctx.db);
    expect(await liveDocumentFor(row.id)).toBe(1);
  });
});
