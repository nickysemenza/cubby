import { and, eq, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { image, searchDocument, derivedRefreshWork } from "~/server/db/schema";
import { backfillImageSearchDocuments } from "~/server/domains/image/service/image-search-backfill.service";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  captureBackgroundQueue,
  drainDerivedRefreshFrontier,
} from "~/server/testing/background-queue";

describe("backfillImageSearchDocuments", () => {
  const ctx = withTestDb();
  let queue: ReturnType<typeof captureBackgroundQueue>;

  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => {
    queue.restore();
  });

  // A bare insert: exactly the state upload paths left behind before they
  // projected on create.
  const insertUnprojected = async (filename: string) =>
    await insertWithShortcode(ctx.db, "image", {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename,
      contentType: "image/jpeg",
      size: 512,
      status: "UPLOADED",
    });

  const liveDocuments = async (imageId: string) =>
    await getDb(ctx.db)
      .select({ id: searchDocument.id })
      .from(searchDocument)
      .where(
        and(
          eq(searchDocument.entityKind, "image"),
          eq(searchDocument.entityId, imageId),
          isNull(searchDocument.deletedAt),
        ),
      );

  it("projects and enqueues every live image lacking a document, across pages", async () => {
    const rows = [
      await insertUnprojected("first.jpg"),
      await insertUnprojected("second.jpg"),
      await insertUnprojected("third.jpg"),
    ];
    const deleted = await insertUnprojected("deleted.jpg");
    await getDb(ctx.db)
      .update(image)
      .set({ deletedAt: new Date() })
      .where(eq(image.id, deleted.id));

    const result = await backfillImageSearchDocuments(ctx.db, {
      batchSize: 2,
      maxBatches: 10,
    });

    expect(result).toMatchObject({
      scanned: 3,
      published: 3,
      remaining: 3,
      stopped: "complete",
    });
    for (const row of rows) {
      expect(await liveDocuments(row.id)).toHaveLength(0);
      expect(
        await getDb(ctx.db)
          .select()
          .from(derivedRefreshWork)
          .where(eq(derivedRefreshWork.entityId, row.id)),
      ).toHaveLength(1);
    }
    await drainDerivedRefreshFrontier(ctx.db);
    for (const row of rows) expect(await liveDocuments(row.id)).toHaveLength(1);
    expect(await liveDocuments(deleted.id)).toHaveLength(0);
  });

  it("stops at the batch limit and reports what remains", async () => {
    await insertUnprojected("one.jpg");
    await insertUnprojected("two.jpg");
    await insertUnprojected("three.jpg");

    const result = await backfillImageSearchDocuments(ctx.db, {
      batchSize: 1,
      maxBatches: 2,
    });

    expect(result).toMatchObject({
      batches: 2,
      scanned: 2,
      remaining: 3,
      stopped: "limit",
    });
  });
});
