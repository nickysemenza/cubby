import { imageId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { image, imageProcessingJob } from "~/server/db/schema";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import { getDb } from "./database-helpers";
import { createUploadedImageRecord } from "./image";
import {
  backfillImageProcessing,
  updateImageProcessingSettings,
} from "./image-processing-maintenance";

describe("backfillImageProcessing", () => {
  const ctx = withTestDb();
  // Wakeups go to a captured queue so nothing dispatches inline in Node.
  let queue: ReturnType<typeof captureBackgroundQueue>;

  beforeEach(() => {
    queue = captureBackgroundQueue();
  });
  afterEach(() => {
    queue.restore();
  });

  const seedImage = async () => {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "backfill.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, row.id));
    return row;
  };

  const jobKinds = async (id: string) => {
    const rows = await getDb(ctx.db)
      .select({ kind: imageProcessingJob.kind })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.imageId, imageId.parse(id)));
    return rows.map((job) => job.kind).sort();
  };

  it("reports paused explicitly and schedules nothing under the default settings", async () => {
    const row = await seedImage();
    const result = await backfillImageProcessing(ctx.db, {
      batchSize: 10,
      retryFailures: false,
    });
    expect(result).toMatchObject({ scheduled: 0, paused: true });
    expect(await jobKinds(row.id)).toEqual([]);
  });

  it("schedules only the requested kinds", async () => {
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
    const row = await seedImage();
    const result = await backfillImageProcessing(ctx.db, {
      batchSize: 10,
      retryFailures: false,
      kinds: ["describe_image"],
    });
    expect(result).toMatchObject({ scheduled: 1, paused: false });
    expect(await jobKinds(row.id)).toEqual(["describe_image"]);
  });

  it("schedules both kinds when none are given", async () => {
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
    const row = await seedImage();
    await backfillImageProcessing(ctx.db, {
      batchSize: 10,
      retryFailures: false,
    });
    expect(await jobKinds(row.id)).toEqual(["describe_image", "subject_lift"]);
  });
});
