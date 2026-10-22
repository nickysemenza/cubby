import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  imageDerivative,
  imageProcessingEvent,
  imageProcessingJob,
} from "~/server/db/image-processing-schema";
import { job as durableJob } from "~/server/db/retained-tables";
import { image } from "~/server/db/schema";
import { createDevice } from "~/server/domains/device/repo/device";
import { claimCompanionImageCommand } from "~/server/domains/image-processing/service/image-processing.service";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";

import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createTransparentDerivativeAndJob,
  IMAGE_PROCESSING_MAX_ATTEMPTS,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  retryFailedImageProcessingJobs,
} from "./image-processing";

// A failure an executor calls retryable must still end: the failure budget
// spent since the last operator retry turns it terminal with its last error,
// an operator retry restores the whole budget, and a hand-off the device
// could not take backs off instead of being reclaimed on its next pull.
describe("image job retry budget", () => {
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
  const jobOf = async (jobId: string) => {
    const [job] = await getDb(ctx.db)
      .select({
        state: imageProcessingJob.state,
        attemptId: imageProcessingJob.attemptId,
        derivativeId: imageProcessingJob.derivativeId,
        attemptsSinceRetry: durableJob.attempts,
        lastError: imageProcessingJob.lastError,
        coolingDown: sql<boolean>`${durableJob.availableAt} > now()`,
      })
      .from(imageProcessingJob)
      .innerJoin(durableJob, eq(durableJob.key, `image-processing:${jobId}`))
      .where(eq(imageProcessingJob.id, jobId));
    if (!job) throw new Error("Missing job");
    return job;
  };
  const makeDue = (jobId: string) =>
    getDb(ctx.db)
      .update(durableJob)
      .set({ availableAt: sql`now()` })
      .where(eq(durableJob.key, `image-processing:${jobId}`));
  const devicePull = () =>
    claimImageProcessingJob(ctx.db, {
      kinds: ["subject_lift"],
      leaseMs: 60_000,
      processorRevisions: [IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION],
    });
  async function failOnce(jobId: string) {
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
          retryable: true,
          reason: "Synthetic transient failure",
        },
      },
    });
    expect(completion.adopted).toBe(true);
    return jobOf(jobId);
  }

  it("fails on the last budgeted retryable failure and restores the budget on operator retry", async () => {
    const { imageId, jobId } = await subjectLiftJob();
    for (let failure = 1; failure < IMAGE_PROCESSING_MAX_ATTEMPTS; failure++)
      expect(await failOnce(jobId)).toMatchObject({
        state: "pending",
        attemptsSinceRetry: failure,
        lastError: "Synthetic transient failure",
      });
    const exhausted = await failOnce(jobId);
    const reason = "Synthetic transient failure";
    expect(exhausted).toMatchObject({
      state: "failed",
      attemptsSinceRetry: IMAGE_PROCESSING_MAX_ATTEMPTS,
      lastError: reason,
    });
    const [derivative] = await getDb(ctx.db)
      .select({
        status: imageDerivative.status,
        failureReason: imageDerivative.failureReason,
      })
      .from(imageDerivative)
      .where(eq(imageDerivative.id, exhausted.derivativeId!));
    expect(derivative).toEqual({ status: "failed", failureReason: reason });

    expect(
      await retryFailedImageProcessingJobs(ctx.db, 10, { imageId }),
    ).toEqual([jobId]);
    expect(await jobOf(jobId)).toMatchObject({
      state: "pending",
      attemptsSinceRetry: 0,
    });
    for (let failure = 1; failure < IMAGE_PROCESSING_MAX_ATTEMPTS; failure++)
      expect(await failOnce(jobId)).toMatchObject({
        state: "pending",
        attemptsSinceRetry: failure,
      });
  });

  it("backs off a refused hand-off so the same device cannot reclaim it before the cooldown", async () => {
    const { jobId } = await subjectLiftJob();
    const installationId = crypto.randomUUID();
    await createDevice(
      ctx.db,
      {
        installationId,
        name: "Synthetic iPad",
        platform: "ios",
        appVersion: null,
        osVersion: null,
        automaticWork: false,
        remotePaused: false,
      },
      TEST_ACTOR,
    );
    const pull = () =>
      claimCompanionImageCommand(ctx.db, {
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
      });

    expect(await pull()).toBeNull();
    expect(await jobOf(jobId)).toMatchObject({
      state: "pending",
      attemptId: null,
      attemptsSinceRetry: 1,
      lastError: "Device assignment was refused",
      coolingDown: true,
    });
    const events = await getDb(ctx.db)
      .select({
        eventKey: imageProcessingEvent.eventKey,
        event: imageProcessingEvent.event,
      })
      .from(imageProcessingEvent)
      .where(eq(imageProcessingEvent.jobId, jobId));
    expect(events).toContainEqual({
      eventKey: "dispatch:backoff",
      event: "dispatch.backoff",
    });
    expect(await pull()).toBeNull();
    expect(await devicePull()).toBeNull();
    expect((await jobOf(jobId)).attemptsSinceRetry).toBe(1);
  });
});
