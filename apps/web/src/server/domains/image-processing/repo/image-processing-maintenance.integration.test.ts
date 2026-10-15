import { imageId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { image, imageProcessingJob } from "~/server/db/schema";
import {
  backfillImageProcessing,
  updateImageProcessingSettings,
} from "~/server/domains/image-processing/service/image-processing-maintenance";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

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
    expect(await jobKinds(row.id)).toEqual([
      "describe_image",
      "describe_image",
    ]);
  });

  it("schedules independent cloud, Apple, and identification baseline jobs when none are given", async () => {
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
    const row = await seedImage();
    await backfillImageProcessing(ctx.db, {
      batchSize: 10,
      retryFailures: false,
    });
    expect(await jobKinds(row.id)).toEqual([
      "describe_image",
      "describe_image",
      "identify_image",
      "subject_lift",
    ]);
  });
});
