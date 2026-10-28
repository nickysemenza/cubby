import { type ImageJobId, parseEntityId } from "@cubby/schemas/identifiers";
import { JOB_NEEDS_ATTENTION_ATTEMPTS } from "@cubby/schemas/job";
import { eq, sql } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  imageDerivative,
  imageProcessingEvent,
  imageProcessingJob,
} from "~/server/db/image-processing-schema";
import {
  job as durableJob,
  jobLaneAdmission,
} from "~/server/db/retained-tables";
import { image } from "~/server/db/schema";
import { createDevice } from "~/server/domains/device/repo/device";
import { claimCompanionImageCommands } from "~/server/domains/image-processing/service/image-processing.service";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import {
  deviceOwnedStreak,
  DEVICE_BACKFILL_SHARE as JOB_BACKFILL_SHARE,
} from "~/server/generic/jobs/repo/device-admission";

import { imageJobDisplayStateSql } from "./image-job-state";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createTransparentDerivativeAndJob,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  retryImageProcessingNow,
} from "./image-processing";

// Production finding: exhausted image Jobs failed while their rows stayed
// leased, and deterministic device failures ended work for good. Image work
// is never abandoned: every failure backs off and retries, repeated failure
// only asks for attention, and a hand-off the server could not make is
// released without spending an attempt.
describe("image job retry policy", () => {
  const ctx = withTestDb();

  async function subjectLiftJob() {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "object.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const hash = "d".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, row.id));
    const imageId = parseEntityId("image", row.id);
    const scheduled = await createTransparentDerivativeAndJob(ctx.db, {
      imageId,
      sourceContentHash: hash,
      key: `pending/${crypto.randomUUID()}.png`,
    });
    if (!scheduled) throw new Error("Expected persisted job");
    return { imageId, jobId: scheduled.jobId };
  }
  const jobOf = async (jobId: ImageJobId) => {
    const [job] = await getDb(ctx.db)
      .select({
        state: imageProcessingJob.state,
        displayed: imageJobDisplayStateSql(),
        attemptId: imageProcessingJob.attemptId,
        derivativeId: imageProcessingJob.derivativeId,
        failures: durableJob.attempts,
        executionState: durableJob.state,
        lastError: imageProcessingJob.lastError,
        coolingDown: sql<boolean>`${durableJob.availableAt} > ${new Date().toISOString()}::timestamp`,
      })
      .from(imageProcessingJob)
      .innerJoin(durableJob, eq(durableJob.key, `image-processing:${jobId}`))
      .where(eq(imageProcessingJob.id, jobId));
    if (!job) throw new Error("Missing job");
    return job;
  };
  const makeDue = (jobId: ImageJobId) =>
    getDb(ctx.db)
      .update(durableJob)
      .set({ availableAt: new Date(0) })
      .where(eq(durableJob.key, `image-processing:${jobId}`));
  const devicePull = () =>
    claimImageProcessingJob(ctx.db, {
      kinds: ["subject_lift"],
      leaseMs: 60_000,
      processorRevisions: [IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION],
    });
  async function failOnce(jobId: ImageJobId, retryable: boolean) {
    await makeDue(jobId);
    const lease = await devicePull();
    if (lease?.id !== jobId) throw new Error("Expected the job's lease");
    const completion = await completeImageProcessingJob(ctx.db, {
      result: {
        jobId,
        attemptId: lease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "subject_lift",
          status: "failed",
          retryable,
          reason: "deadline_exceeded",
        },
      },
    });
    expect(completion.adopted).toBe(true);
    return jobOf(jobId);
  }

  it("retries every failure, retryable or not, and only asks for attention after repeated failures", async () => {
    const { imageId, jobId } = await subjectLiftJob();
    for (
      let failure = 1;
      failure <= JOB_NEEDS_ATTENTION_ATTEMPTS + 1;
      failure++
    ) {
      const after = await failOnce(jobId, failure % 2 === 0);
      expect(after).toMatchObject({
        state: "pending",
        executionState: "retry_wait",
        failures: failure,
        lastError: "deadline_exceeded",
        coolingDown: true,
        displayed:
          failure >= JOB_NEEDS_ATTENTION_ATTEMPTS
            ? "failed"
            : "waiting_for_device",
      });
    }
    const exhausted = await jobOf(jobId);
    const [derivative] = await getDb(ctx.db)
      .select({ status: imageDerivative.status })
      .from(imageDerivative)
      .where(eq(imageDerivative.id, exhausted.derivativeId!));
    // The output stays pending for the next attempt, never failed.
    expect(derivative?.status).toBe("pending");

    expect(await retryImageProcessingNow(ctx.db, { imageId })).toEqual([jobId]);
    expect(await jobOf(jobId)).toMatchObject({
      state: "pending",
      failures: 0,
      coolingDown: false,
      lastError: "deadline_exceeded",
      displayed: "waiting_for_device",
    });
  });

  it("releases a refused hand-off without an attempt so another device can take it", async () => {
    const { jobId } = await subjectLiftJob();
    const device = async (automaticWork: boolean) => {
      const installationId = parseEntityId("device", crypto.randomUUID());
      await createDevice(
        ctx.db,
        {
          installationId,
          name: "Synthetic iPad",
          platform: "ios",
          appVersion: null,
          osVersion: null,
          automaticWork,
          remotePaused: false,
        },
        TEST_ACTOR,
      );
      return () =>
        claimCompanionImageCommands(ctx.db, {
          device: {
            deviceId: installationId,
            platform: "ios",
            appVersion: "1",
            deviceName: "Synthetic iPad",
            osVersion: "26",
            capabilities: {
              foreground: true,
              visionSubjectLift: { available: true, revision: 1 },
              actualImageDescription: { available: false },
            },
          },
          userId: TEST_ACTOR.userId,
          leaseMs: 60_000,
          maxCommands: 1,
        }).then((commands) => commands[0] ?? null);
    };
    // Backfill's turn is due; the refused hand-off must leave it owed.
    const DEVICE_OWNED_STREAK = Math.ceil(1 / JOB_BACKFILL_SHARE) - 1;
    await getDb(ctx.db)
      .insert(jobLaneAdmission)
      .values({ lane: "image.device", ownedStreak: DEVICE_OWNED_STREAK })
      .onConflictDoUpdate({
        target: jobLaneAdmission.lane,
        set: { ownedStreak: DEVICE_OWNED_STREAK },
      });
    const optedOut = await device(false);
    expect(await optedOut()).toBeNull();
    expect(await deviceOwnedStreak(ctx.db)).toBe(DEVICE_OWNED_STREAK);
    expect(await jobOf(jobId)).toMatchObject({
      state: "pending",
      executionState: "queued",
      failures: 0,
      coolingDown: false,
    });
    const events = await getDb(ctx.db)
      .select({ event: imageProcessingEvent.event })
      .from(imageProcessingEvent)
      .where(eq(imageProcessingEvent.jobId, jobId));
    expect(events).toContainEqual({ event: "dispatch.released" });
    const participating = await device(true);
    expect(await participating()).toMatchObject({ jobId });
  });
});
