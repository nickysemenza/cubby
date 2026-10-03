import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import {
  image,
  imageProcessingAttempt,
  imageProcessingJob,
} from "~/server/db/schema";

import { getDb } from "./database-helpers";
import { createUploadedImageRecord } from "./image";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  releaseAssignedImageProcessingJob,
} from "./image-processing";
import { assignImageProcessingExecutor } from "./image-processing-history";
import { updateImageProcessingSettings } from "./image-processing-maintenance";

// Background claims must not steal cloud jobs. An interrupted device must release only its own
// attempt, retain execution history, and leave a subsequent attempt immune to late results.
describe("background companion leases", () => {
  const ctx = withTestDb();
  const userId = "synthetic-background-user";
  const deviceId = crypto.randomUUID();
  beforeEach(async () => {
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
  });
  async function job(processorRevision: number, contentType = "image/jpeg") {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "panel.jpg",
      contentType,
      size: 512,
    });
    const hash = "b".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, row.id));
    const created = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      kind: "describe_image",
      sourceContentHash: hash,
      processorRevision,
    });
    if (!created) throw new Error("Expected job");
    return created;
  }
  const claim = () =>
    claimImageProcessingJob(ctx.db, {
      kinds: ["describe_image"],
      leaseMs: 60_000,
      processorRevisions: [IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION],
    });
  it("filters processor revision and exclusively claims each device job", async () => {
    const cloud = await job(IMAGE_DESCRIPTION_PROCESSOR_REVISION);
    const apple = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const leases = await Promise.all([claim(), claim()]);
    expect(leases.filter(Boolean).map((lease) => lease?.id)).toEqual([apple]);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, cloud));
    expect(saved?.state).toBe("pending");
  });
  it("leases only cloud AVIF work for a normalization-only companion", async () => {
    const jpeg = await job(IMAGE_DESCRIPTION_PROCESSOR_REVISION);
    const apple = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const avif = await job(IMAGE_DESCRIPTION_PROCESSOR_REVISION, "image/avif");
    const lease = await claimImageProcessingJob(ctx.db, {
      kinds: ["describe_image"],
      leaseMs: 60_000,
      processorRevisions: [],
      allowAvifNormalization: true,
    });
    expect(lease?.id).toBe(avif);
    expect(
      await claimImageProcessingJob(ctx.db, {
        kinds: ["describe_image"],
        leaseMs: 60_000,
        processorRevisions: [],
        allowAvifNormalization: true,
      }),
    ).toBeNull();
    const remaining = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(sql`${imageProcessingJob.id} in (${jpeg}, ${apple})`);
    expect(remaining.map((row) => row.state)).toEqual(["pending", "pending"]);
  });
  it("rejects another device's release and rejects a released attempt's late result", async () => {
    await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const first = await claim();
    if (!first) throw new Error("Expected lease");
    await assignImageProcessingExecutor(ctx.db, {
      jobId: first.id,
      attemptId: first.attemptId,
      userId,
      executor: {
        kind: "device",
        deviceId,
        name: "Test phone",
        platform: "ios",
        appVersion: "1",
        osVersion: "26",
      },
    });
    expect(
      await releaseAssignedImageProcessingJob(ctx.db, {
        jobId: first.id,
        attemptId: first.attemptId,
        userId,
        deviceId: crypto.randomUUID(),
      }),
    ).toBe(false);
    expect(
      await releaseAssignedImageProcessingJob(ctx.db, {
        jobId: first.id,
        attemptId: first.attemptId,
        userId,
        deviceId,
      }),
    ).toBe(true);
    expect(
      await releaseAssignedImageProcessingJob(ctx.db, {
        jobId: first.id,
        attemptId: first.attemptId,
        userId,
        deviceId,
      }),
    ).toBe(false);
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ nextAttemptAt: sql`now()` })
      .where(eq(imageProcessingJob.id, first.id));
    const second = await claim();
    expect(second?.attemptId).not.toBe(first.attemptId);
    const completion = await completeImageProcessingJob(ctx.db, {
      result: {
        jobId: first.id,
        attemptId: first.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "describe_image",
          status: "failed",
          reason: "cancelled",
          retryable: true,
        },
      },
    });
    expect(completion.adopted).toBe(false);
    const [attempt] = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, first.attemptId));
    expect(attempt?.state).toBe("failed");
    expect(attempt?.error).toBe("Background execution released");
  });
});
