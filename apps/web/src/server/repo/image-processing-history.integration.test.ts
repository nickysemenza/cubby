import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import {
  aiAnalysis,
  image,
  imageProcessingAttempt,
  imageProcessingEvent,
  imageProcessingJob,
  imageProcessingOrphan,
  imageProcessingSubmissionJob,
} from "~/server/db/schema";
import { scheduleImageProcessingJobs } from "~/server/services/image-processing.service";

import {
  reserveImageAnalysisInput,
  retainImageAnalysisInput,
} from "./activity-input";
import { getDb } from "./database-helpers";
import { createUploadedImageRecord, deleteImages } from "./image";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  findImageProcessingDispatchRepairs,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  markImageProcessingWaitingForDevice,
  reclaimExpiredImageProcessingLeases,
  retryFailedImageProcessingJobs,
} from "./image-processing";
import {
  assignImageProcessingExecutor,
  createImageProcessingSubmission,
  isAssignedImageProcessingDevice,
} from "./image-processing-history";
import { updateImageProcessingSettings } from "./image-processing-maintenance";

describe("image execution history conservation", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await updateImageProcessingSettings(ctx.db, {
      enabled: false,
      paused: false,
    });
  });
  async function setup() {
    const source = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "sample.jpg",
      contentType: "image/jpeg",
      size: 128,
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "a".repeat(64) })
      .where(eq(image.id, source.id));
    const scheduled = await scheduleImageProcessingJobs(ctx.db, {
      id: source.shortcode,
      kinds: ["describe_image"],
      publish: false,
    });
    const jobId = scheduled.jobIds[0];
    if (!jobId) throw new Error("Missing test job");
    return { source, scheduled, jobId };
  }
  async function claim(jobId: string) {
    const lease = await claimImageProcessingJob(ctx.db, {
      jobId,
      kinds: ["describe_image"],
      leaseMs: 60_000,
    });
    if (!lease) throw new Error("Missing test lease");
    return lease;
  }
  it("fixes submission membership, reuses running work, and assigns each retry to only its new submission", async () => {
    const { source, jobId } = await setup();
    const repeated = await scheduleImageProcessingJobs(ctx.db, {
      id: source.shortcode,
      kinds: ["describe_image"],
      publish: false,
    });
    expect(repeated.jobIds).toEqual([jobId]);
    const memberships = await getDb(ctx.db)
      .select()
      .from(imageProcessingSubmissionJob)
      .where(eq(imageProcessingSubmissionJob.jobId, jobId));
    expect(memberships.map((row) => row.disposition).sort()).toEqual([
      "new",
      "running",
    ]);
    const lease = await claim(jobId);
    await completeImageProcessingJob(ctx.db, {
      result: {
        jobId,
        attemptId: lease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "describe_image",
          status: "failed",
          retryable: false,
          reason: "Test provider failure",
        },
      },
    });
    const submission = await createImageProcessingSubmission(ctx.db);
    expect(
      await retryFailedImageProcessingJobs(ctx.db, 25, {
        submissionId: submission.id,
      }),
    ).toEqual([jobId]);
    expect(
      await retryFailedImageProcessingJobs(ctx.db, 25, {
        submissionId: submission.id,
      }),
    ).toEqual([]);
    const next = await claim(jobId);
    const attempts = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.jobId, jobId))
      .orderBy(imageProcessingAttempt.number);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.state).toBe("failed");
    expect(attempts[1]?.id).toBe(next.attemptId);
    expect(attempts[1]?.submissionId).toBe(submission.id);
    expect(attempts[0]?.submissionId).not.toBe(submission.id);
  });
  it("records waiting without a device call, binds assignments, preserves expiry and rejects stale delivery once", async () => {
    const { jobId } = await setup();
    const waiting = await claim(jobId);
    await markImageProcessingWaitingForDevice(ctx.db, {
      jobId,
      attemptId: waiting.attemptId,
    });
    const [waitAttempt] = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, waiting.attemptId));
    expect(waitAttempt?.executor).toBeNull();
    expect(waitAttempt?.state).toBe("waiting");
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ nextAttemptAt: sql`now()` })
      .where(eq(imageProcessingJob.id, jobId));
    const lease = await claim(jobId);
    const deviceId = crypto.randomUUID();
    const assignment = {
      jobId,
      attemptId: lease.attemptId,
      userId: "test-user",
      connectionId: crypto.randomUUID(),
      executor: {
        kind: "device" as const,
        deviceId,
        name: "Test Mac",
        platform: "macos" as const,
        appVersion: "1",
        osVersion: "26",
      },
    };
    expect(await assignImageProcessingExecutor(ctx.db, assignment)).toBe(true);
    expect(await assignImageProcessingExecutor(ctx.db, assignment)).toBe(false);
    expect(
      await isAssignedImageProcessingDevice(ctx.db, {
        jobId,
        attemptId: lease.attemptId,
        userId: "another-user",
        deviceId,
      }),
    ).toBe(false);
    await reclaimExpiredImageProcessingLeases(
      ctx.db,
      new Date(Date.now() + 120_000),
    );
    const result = {
      jobId,
      attemptId: lease.attemptId,
      completedAt: new Date().toISOString(),
      outcome: {
        kind: "describe_image" as const,
        status: "skipped" as const,
        reason: "unsupported_format" as const,
      },
    };
    expect((await completeImageProcessingJob(ctx.db, { result })).adopted).toBe(
      false,
    );
    expect((await completeImageProcessingJob(ctx.db, { result })).adopted).toBe(
      false,
    );
    const [expired] = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, lease.attemptId));
    expect(expired?.state).toBe("expired");
    expect(expired?.executor?.deviceId).toBe(deviceId);
    const events = await getDb(ctx.db)
      .select()
      .from(imageProcessingEvent)
      .where(eq(imageProcessingEvent.jobId, jobId));
    expect(
      events.filter((event) => event.event === "completion.rejected"),
    ).toHaveLength(1);
  });
  it("retains immutable input cleanup across deletion and a late upload", async () => {
    const { source, jobId } = await setup();
    const lease = await claim(jobId);
    const key = `tests/input-${lease.attemptId}.jpg`;
    expect(await reserveImageAnalysisInput(ctx.db, lease.attemptId, key)).toBe(
      true,
    );
    expect(await retainImageAnalysisInput(ctx.db, lease.attemptId, key)).toBe(
      true,
    );
    await deleteImages(ctx.db, [parseEntityId("image", source.id)]);
    expect(await retainImageAnalysisInput(ctx.db, lease.attemptId, key)).toBe(
      false,
    );
    const orphans = await getDb(ctx.db)
      .select()
      .from(imageProcessingOrphan)
      .where(eq(imageProcessingOrphan.key, key));
    expect(orphans).toHaveLength(1);
  });
  it("does not retry terminal skips or failures for an obsolete source", async () => {
    const { source, jobId } = await setup();
    const lease = await claim(jobId);
    await completeImageProcessingJob(ctx.db, {
      result: {
        jobId,
        attemptId: lease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "describe_image",
          status: "failed",
          retryable: false,
          reason: "Old source failed",
        },
      },
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, source.id));
    expect(await retryFailedImageProcessingJobs(ctx.db, 25)).toEqual([]);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "a".repeat(64) })
      .where(eq(image.id, source.id));
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "skipped" })
      .where(eq(imageProcessingJob.id, jobId));
    expect(await retryFailedImageProcessingJobs(ctx.db, 25)).toEqual([]);
  });
  it("repairs a live wakeup past more obsolete rows than its batch limit", async () => {
    const { source, jobId } = await setup();
    const sourceId = parseEntityId("image", source.id);
    await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          imageId: sourceId,
          kind: "describe_image" as const,
          state: "pending" as const,
          sourceContentHash: index.toString(16).padStart(64, "0"),
          processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
          nextAttemptAt: new Date(0),
        })),
      );

    expect(await findImageProcessingDispatchRepairs(ctx.db, 100)).toEqual([
      jobId,
    ]);

    const obsolete = await getDb(ctx.db)
      .select({ state: imageProcessingJob.state })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.imageId, sourceId));
    expect(obsolete.filter((row) => row.state === "skipped")).toHaveLength(100);
  });
  it("adopts cloud analysis only with its live lease and keeps rejected output in attempt history", async () => {
    const { source, jobId } = await setup();
    const old = await claim(jobId);
    await reclaimExpiredImageProcessingLeases(
      ctx.db,
      new Date(Date.now() + 120_000),
    );
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ nextAttemptAt: sql`now()` })
      .where(eq(imageProcessingJob.id, jobId));
    const current = await claim(jobId);
    const cloudAnalysis = {
      provider: "test",
      model: "test-vision",
      promptRevision: 1,
      resultSchemaRevision: 1,
      inputFingerprint: "test-input",
    };
    const outcome = {
      kind: "describe_image" as const,
      status: "completed" as const,
      description: {
        description: "A test object",
        claims: [],
        cutoutEligibility: "eligible" as const,
      },
      runtime: { platform: "cloud" as const, model: "test-vision" },
    };
    expect(
      (
        await completeImageProcessingJob(ctx.db, {
          result: {
            jobId,
            attemptId: old.attemptId,
            completedAt: new Date().toISOString(),
            outcome,
          },
          cloudAnalysis,
        })
      ).adopted,
    ).toBe(false);
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiAnalysis)
        .where(eq(aiAnalysis.entityId, source.id)),
    ).toHaveLength(0);
    expect(
      (
        await completeImageProcessingJob(ctx.db, {
          result: {
            jobId,
            attemptId: current.attemptId,
            completedAt: new Date().toISOString(),
            outcome,
          },
          cloudAnalysis,
        })
      ).adopted,
    ).toBe(true);
    expect(
      (
        await completeImageProcessingJob(ctx.db, {
          result: {
            jobId,
            attemptId: current.attemptId,
            completedAt: new Date().toISOString(),
            outcome,
          },
          cloudAnalysis,
        })
      ).adopted,
    ).toBe(false);
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiAnalysis)
        .where(eq(aiAnalysis.entityId, source.id)),
    ).toHaveLength(1);
  });
});
