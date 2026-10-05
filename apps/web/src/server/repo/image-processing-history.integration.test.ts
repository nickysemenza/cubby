import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  aiAnalysis,
  image,
  imageProcessingAttempt,
  imageProcessingEvent,
  imageProcessingJob,
  imageProcessingOrphan,
  imageProcessingSubmissionJob,
} from "~/server/db/schema";
import {
  scheduleImageProcessingJobs,
  completeCompanionImageProcessingResult,
} from "~/server/services/image-processing.service";
import * as storage from "~/server/utils/s3";

import {
  reserveImageAnalysisInput,
  retainImageAnalysisInput,
} from "./activity-input";
import { getDb } from "./database-helpers";
import { createDevice, getDeviceByID, updateDevice } from "./device";
import { upsertDeviceFromHello } from "./device-participation";
import { createUploadedImageRecord, deleteImages } from "./image";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  findImageProcessingDispatchRepairs,
  getLeasedImageProcessingJobContext,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
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
  const assignCloud = (jobId: string, attemptId: string) =>
    assignImageProcessingExecutor(ctx.db, {
      jobId,
      attemptId,
      executor: {
        kind: "cloud",
        deviceId: null,
        name: "test",
        platform: "cloud",
        appVersion: null,
        osVersion: null,
      },
    });
  it("preserves a device's edited name across hello and records it on new activity", async () => {
    const installationId = crypto.randomUUID();
    const created = await createDevice(
      ctx.db,
      {
        installationId,
        name: "iPhone",
        platform: "ios",
        appVersion: null,
        osVersion: null,
        automaticWork: true,
        remotePaused: false,
      },
      TEST_ACTOR,
    );
    await updateDevice(
      ctx.db,
      created.output.id,
      { name: "Kitchen phone" },
      TEST_ACTOR,
    );

    await upsertDeviceFromHello(ctx.db, {
      installationId,
      name: "stale-host.local",
      platform: "ios",
      appVersion: "1.1",
      osVersion: "26",
      automaticWork: true,
    });
    expect((await getDeviceByID(ctx.db, created.entityId)).name).toBe(
      "Kitchen phone",
    );

    const { jobId } = await setup();
    const lease = await claim(jobId);
    expect(
      await assignImageProcessingExecutor(ctx.db, {
        jobId,
        attemptId: lease.attemptId,
        executor: {
          kind: "device",
          deviceId: installationId,
          name: "stale-host.local",
          platform: "ios",
          appVersion: "1.1",
          osVersion: "26",
        },
      }),
    ).toBe(true);
    const [attempt] = await getDb(ctx.db)
      .select({ executor: imageProcessingAttempt.executor })
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, lease.attemptId));
    expect(attempt?.executor?.name).toBe("Kitchen phone");
  });
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
    expect(await assignCloud(jobId, next.attemptId)).toBe(true);
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
    // A lease nobody executes is not an attempt.
    expect(
      await getDb(ctx.db)
        .select()
        .from(imageProcessingAttempt)
        .where(eq(imageProcessingAttempt.jobId, jobId)),
    ).toHaveLength(0);
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
  it("refuses a device assignment its own Device row has opted out of, and re-permits it once re-enabled", async () => {
    const { jobId } = await setup();
    const installationId = crypto.randomUUID();
    const { entityId: deviceEntityId } = await createDevice(
      ctx.db,
      {
        installationId,
        name: "Test Mac",
        platform: "macos",
        appVersion: null,
        osVersion: null,
        automaticWork: false,
        remotePaused: false,
      },
      TEST_ACTOR,
    );
    const lease = await claim(jobId);
    const assignment = {
      jobId,
      attemptId: lease.attemptId,
      userId: "test-user",
      connectionId: crypto.randomUUID(),
      executor: {
        kind: "device" as const,
        deviceId: installationId,
        name: "Test Mac",
        platform: "macos" as const,
        appVersion: "1",
        osVersion: "26",
      },
    };
    // `automaticWork: false` refuses the assignment even though the job and
    // attempt are otherwise perfectly leasable — the authoritative re-check
    // `dispatch()`'s cached socket attachment cannot substitute for.
    expect(await assignImageProcessingExecutor(ctx.db, assignment)).toBe(false);
    const created = await getDeviceByID(ctx.db, deviceEntityId);
    await updateDevice(ctx.db, created.id, { automaticWork: true }, TEST_ACTOR);
    expect(await assignImageProcessingExecutor(ctx.db, assignment)).toBe(true);
  });
  it("refuses a device assignment while its Device row is remotely paused", async () => {
    const { jobId } = await setup();
    const installationId = crypto.randomUUID();
    await createDevice(
      ctx.db,
      {
        installationId,
        name: "Test iPhone",
        platform: "ios",
        appVersion: null,
        osVersion: null,
        automaticWork: true,
        remotePaused: true,
      },
      TEST_ACTOR,
    );
    const lease = await claim(jobId);
    const assignment = {
      jobId,
      attemptId: lease.attemptId,
      userId: "test-user",
      connectionId: crypto.randomUUID(),
      executor: {
        kind: "device" as const,
        deviceId: installationId,
        name: "Test iPhone",
        platform: "ios" as const,
        appVersion: "1",
        osVersion: "26",
      },
    };
    expect(await assignImageProcessingExecutor(ctx.db, assignment)).toBe(false);
  });
  it("retains immutable input cleanup across deletion and a late upload", async () => {
    const { source, jobId } = await setup();
    const lease = await claim(jobId);
    expect(await assignCloud(jobId, lease.attemptId)).toBe(true);
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
  // A companion can return after its signed PUT or lease expires, or after the source changes.
  // Neither a new reservation nor retaining uploaded input may revive that stale attempt.
  it.each(["expired", "replaced", "deleted"])(
    "fences analysis input after the source is %s",
    async (change) => {
      const { source, jobId } = await setup();
      const lease = await claim(jobId);
      expect(await assignCloud(jobId, lease.attemptId)).toBe(true);
      const key = `tests/input-${lease.attemptId}.jpg`;
      expect(
        await reserveImageAnalysisInput(ctx.db, lease.attemptId, key),
      ).toBe(true);
      if (change === "expired") {
        await getDb(ctx.db)
          .update(imageProcessingJob)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(imageProcessingJob.id, jobId));
      } else if (change === "replaced") {
        await getDb(ctx.db)
          .update(image)
          .set({ sha256: "b".repeat(64) })
          .where(eq(image.id, source.id));
      } else {
        await deleteImages(ctx.db, [parseEntityId("image", source.id)]);
      }
      expect(
        await getLeasedImageProcessingJobContext(ctx.db, {
          jobId,
          attemptId: lease.attemptId,
        }),
      ).toBeNull();
      expect(await retainImageAnalysisInput(ctx.db, lease.attemptId, key)).toBe(
        false,
      );
      expect(
        await reserveImageAnalysisInput(ctx.db, lease.attemptId, `${key}.late`),
      ).toBe(false);
    },
  );
  it("consumes a staging input once when normalization results arrive concurrently", async () => {
    const { jobId } = await setup();
    const lease = await claim(jobId);
    await assignCloud(jobId, lease.attemptId);
    const stage = `tests/stage-${lease.attemptId}.jpg`;
    expect(
      await reserveImageAnalysisInput(ctx.db, lease.attemptId, stage),
    ).toBe(true);
    const snapshots = [
      `tests/snapshot-a-${lease.attemptId}.jpg`,
      `tests/snapshot-b-${lease.attemptId}.jpg`,
    ];
    const reservations = await Promise.all(
      snapshots.map((key) =>
        reserveImageAnalysisInput(ctx.db, lease.attemptId, key, stage),
      ),
    );
    expect(reservations.filter(Boolean)).toHaveLength(1);
    const winner = snapshots[reservations.indexOf(true)]!;
    expect(
      await retainImageAnalysisInput(ctx.db, lease.attemptId, winner),
    ).toBe(true);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    expect(saved?.state).toBe("leased");
  });
  it("allows only the normalization owner to read storage and fail its attempt", async () => {
    const { source, jobId } = await setup();
    await getDb(ctx.db)
      .update(image)
      .set({ contentType: "image/avif" })
      .where(eq(image.id, source.id));
    const lease = await claim(jobId);
    await assignCloud(jobId, lease.attemptId);
    const key = storage.imageAnalysisKey("staging", lease.attemptId);
    await reserveImageAnalysisInput(ctx.db, lease.attemptId, key);
    const result = {
      jobId,
      attemptId: lease.attemptId,
      completedAt: new Date().toISOString(),
      outcome: {
        kind: "describe_image" as const,
        status: "normalized" as const,
        key,
        contentType: "image/jpeg" as const,
        sha256: "b".repeat(64),
        width: 2,
        height: 3,
      },
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi
      .spyOn(storage, "getS3Object")
      .mockImplementation(async () => {
        await gate;
        return new Response("synthetic storage failure", { status: 503 });
      });
    try {
      const completions = [
        completeCompanionImageProcessingResult(ctx.db, result),
        completeCompanionImageProcessingResult(ctx.db, result),
      ];
      await vi.waitFor(() => expect(read).toHaveBeenCalled());
      release();
      await Promise.all(completions);
      expect(read).toHaveBeenCalledTimes(1);
      const [saved] = await getDb(ctx.db)
        .select()
        .from(imageProcessingJob)
        .where(eq(imageProcessingJob.id, jobId));
      expect(saved?.state).toBe("pending");
    } finally {
      release();
      read.mockRestore();
    }
  });
  it("rejects a normalization result for an unreserved output key without adopting it", async () => {
    const { source, jobId } = await setup();
    await getDb(ctx.db)
      .update(image)
      .set({ contentType: "image/avif" })
      .where(eq(image.id, source.id));
    const lease = await claim(jobId);
    await assignCloud(jobId, lease.attemptId);
    await reserveImageAnalysisInput(
      ctx.db,
      lease.attemptId,
      storage.imageAnalysisKey("staging", lease.attemptId),
    );
    expect(
      await completeCompanionImageProcessingResult(ctx.db, {
        jobId,
        attemptId: lease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "describe_image",
          status: "normalized",
          key: "unreserved.jpg",
          contentType: "image/jpeg",
          sha256: "b".repeat(64),
          width: 2,
          height: 3,
        },
      }),
    ).toEqual({ adopted: false });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    expect(saved?.state).toBe("leased");
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiAnalysis)
        .where(eq(aiAnalysis.entityId, source.id)),
    ).toEqual([]);
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
  it("retires obsolete processor wakeups without executing them or changing completed history", async () => {
    const { source, jobId } = await setup();
    const sourceId = parseEntityId("image", source.id);
    const revisions = Array.from(
      { length: 104 },
      (_, index) => index + 1,
    ).filter(
      (revision) =>
        ![
          IMAGE_DESCRIPTION_PROCESSOR_REVISION,
          IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
        ].includes(revision),
    );
    const obsolete = await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values(
        revisions.slice(0, 101).map((processorRevision) => ({
          imageId: sourceId,
          kind: "describe_image" as const,
          state: "pending" as const,
          sourceContentHash: "a".repeat(64),
          processorRevision,
          nextAttemptAt: new Date(0),
        })),
      )
      .returning({ id: imageProcessingJob.id });
    const historyResult = {
      kind: "describe_image",
      status: "completed",
      description: {
        description: "Synthetic old analysis",
        claims: [],
        cutoutEligibility: "review",
      },
    };
    const [history] = await getDb(ctx.db)
      .insert(imageProcessingJob)
      .values({
        imageId: sourceId,
        kind: "describe_image",
        state: "ready",
        sourceContentHash: "a".repeat(64),
        processorRevision: revisions[101]!,
        result: historyResult,
        completedAt: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    expect(
      await claimImageProcessingJob(ctx.db, {
        jobId: obsolete[0]!.id,
        kinds: ["describe_image"],
        leaseMs: 60_000,
      }),
    ).toBeNull();
    expect(await findImageProcessingDispatchRepairs(ctx.db, 100)).toEqual([
      jobId,
    ]);
    const retired = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.imageId, sourceId));
    const obsoleteRows = retired.filter((row) =>
      obsolete.some((entry) => entry.id === row.id),
    );
    expect(obsoleteRows.filter((row) => row.state === "skipped")).toHaveLength(
      100,
    );
    expect(
      obsoleteRows.filter(
        (row) =>
          row.lastError === "Image processor revision is no longer current",
      ),
    ).toHaveLength(100);
    expect(obsoleteRows.every((row) => row.attempts === 0)).toBe(true);
    expect(retired.find((row) => row.id === history!.id)).toEqual(history);
    expect(
      await claimImageProcessingJob(ctx.db, {
        jobId,
        kinds: ["describe_image"],
        leaseMs: 60_000,
      }),
    ).toMatchObject({
      processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
    });
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
