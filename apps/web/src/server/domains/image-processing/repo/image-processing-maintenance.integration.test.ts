import { imageId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  image,
  imageProcessingJob,
  imageProcessingSubmission,
} from "~/server/db/schema";
import {
  backfillImageProcessing,
  repairImageProcessingWork,
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

  // Missing jobs must be recovered without a manual batch button. Repeated
  // recovery must neither duplicate jobs nor manufacture empty submissions.
  it("automatically backfills missing jobs and leaves settled work alone", async () => {
    const row = await seedImage();
    await repairImageProcessingWork(ctx.db);
    expect(await jobKinds(row.id)).toEqual([
      "describe_image",
      "describe_image",
      "identify_image",
      "subject_lift",
    ]);
    const before = await getDb(ctx.db).select().from(imageProcessingSubmission);
    await repairImageProcessingWork(ctx.db);
    expect(
      await getDb(ctx.db).select().from(imageProcessingSubmission),
    ).toEqual(before);
    expect(await jobKinds(row.id)).toEqual([
      "describe_image",
      "describe_image",
      "identify_image",
      "subject_lift",
    ]);
    expect(
      queue.tasks.some((task) => task.kind === "image-processing.wakeup"),
    ).toBe(true);
  });

  it("schedules jobs without an enable or resume step", async () => {
    const row = await seedImage();
    const result = await backfillImageProcessing(ctx.db, {
      batchSize: 10,
      retryFailures: false,
    });
    expect(result).toMatchObject({ scheduled: 1, paused: false });
    expect(await jobKinds(row.id)).toEqual([
      "describe_image",
      "describe_image",
      "identify_image",
      "subject_lift",
    ]);
  });

  it("schedules only the requested kinds", async () => {
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
