import { WORK_NEEDS_ATTENTION_ATTEMPTS } from "@cubby/schemas/execution";
import { type ImageJobId, parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  imageDerivative,
  imageProcessingEvent,
  imageProcessingJob,
} from "~/server/db/image-processing-schema";
import { image } from "~/server/db/schema";
import { createDevice } from "~/server/domains/device/repo/device";
import {
  readImageExecution,
  updateImageExecution,
} from "~/server/domains/image-processing/repo/image-execution.fixtures";
import { IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION } from "~/server/domains/image-processing/repo/processor-policy";
import { claimCompanionImageCommands } from "~/server/domains/image-processing/service/image-processing.service";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";

import { imageJobDisplayStateSql } from "./image-job-state";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createTransparentDerivativeAndJob,
  retryImageProcessingNow,
} from "./image-processing";

// Transient failures retry; deterministic refusals retain evidence for an explicit
// retry. A refused hand-off spends no attempt.
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
        lastError: imageProcessingJob.lastError,
      })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    const execution = await readImageExecution(ctx.db, jobId);
    if (!job || !execution) throw new Error("Missing job");
    return {
      ...job,
      failures: execution.attempts,
      executionState: execution.state,
      coolingDown: execution.availableAt > new Date(),
    };
  };
  const makeDue = (jobId: ImageJobId) =>
    updateImageExecution(ctx.db, jobId, { runAt: new Date(0) });
  const devicePull = () =>
    claimImageProcessingJob(ctx.db, {
      kinds: ["subject_lift"],
      leaseMs: 60_000,
      processorRevisions: [IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION],
    });
  async function failOnce(jobId: ImageJobId, retryable: boolean) {
    await makeDue(jobId);
    const lease = await devicePull();
    if (!lease) throw new Error("Expected the job's lease");
    const completion = await completeImageProcessingJob(ctx.db, {
      result: {
        jobId: lease.id,
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

  it("retries transient failures and retains deterministic failures until explicit retry", async () => {
    const { imageId, jobId } = await subjectLiftJob();
    for (
      let failure = 1;
      failure <= WORK_NEEDS_ATTENTION_ATTEMPTS + 1;
      failure++
    ) {
      const after = await failOnce(jobId, true);
      expect(after).toMatchObject({
        state: "pending",
        executionState: "retry_wait",
        failures: failure,
        lastError: "deadline_exceeded",
        coolingDown: true,
        displayed:
          failure >= WORK_NEEDS_ATTENTION_ATTEMPTS
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

    await failOnce(jobId, false);
    expect(await jobOf(jobId)).toMatchObject({
      state: "failed",
      displayed: "failed",
      lastError: "deadline_exceeded",
    });
    await makeDue(jobId);
    expect(await devicePull()).toBeNull();

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
    const optedOut = await device(false);
    expect(await optedOut()).toBeNull();
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
