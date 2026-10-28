import { type ImageJobId, parseEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { AiBudgetExhaustedError } from "~/server/ai/budget";
import * as storage from "~/server/clients/s3";
import { getDb } from "~/server/db/helpers";
import { job as durableJob } from "~/server/db/retained-tables";
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
  createDevice,
  readDeviceById,
  updateDevice,
} from "~/server/domains/device/repo/device";
import { upsertDeviceFromHello } from "~/server/domains/device/repo/device-participation";
import * as cloudDescription from "~/server/domains/image-processing/service/cloud-description";
import {
  scheduleImageProcessingJobs,
  completeCompanionImageProcessingResult,
} from "~/server/domains/image-processing/service/image-processing.service";
import {
  createUploadedImageRecord,
  deleteImages,
} from "~/server/domains/image/repo/image";
import {
  reserveImageAnalysisInput,
  retainImageAnalysisInput,
} from "~/server/generic/activity/repo/activity-input";
import { derivedMarkTickets } from "~/server/testing/background-queue";

import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  getLeasedImageProcessingJobContext,
  retryImageProcessingNow,
} from "./image-processing";
import {
  assignImageProcessingExecutor,
  createImageProcessingSubmission,
  findImageProcessingDeviceAssignment,
} from "./image-processing-history";

describe("image execution history conservation", () => {
  const ctx = withTestDb();
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
  async function claim(jobId: ImageJobId) {
    const lease = await claimImageProcessingJob(ctx.db, {
      jobId,
      kinds: ["describe_image"],
      leaseMs: 60_000,
    });
    if (!lease) throw new Error("Missing test lease");
    return lease;
  }
  const assignCloud = (jobId: ImageJobId, attemptId: string) =>
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

  // Both native pulls and queue dispatch must claim the same execution row;
  // history/processing payloads cannot retain an independent retry owner.
  it("uses the committed universal Job lease for native capabilities", async () => {
    const { jobId } = await setup();
    const [intent] = await getDb(ctx.db)
      .select()
      .from(durableJob)
      .where(eq(durableJob.key, `image-processing:${jobId}`));
    // A JPEG cloud description runs in the server's cloud lane.
    expect(intent?.kind).toBe("image.cloud");
    const lease = await claim(jobId);
    const [running] = await getDb(ctx.db)
      .select()
      .from(durableJob)
      .where(eq(durableJob.id, intent!.id));
    expect(running?.leaseToken).toBe(lease.attemptId);
    expect(running?.leaseExpiresAt).toEqual(lease.leaseExpiresAt);
    expect(
      await claimImageProcessingJob(ctx.db, {
        jobId,
        kinds: ["describe_image"],
        leaseMs: 60_000,
      }),
    ).toBeNull();
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
    expect((await readDeviceById(ctx.db, created.entityId)).name).toBe(
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
    expect(repeated.jobIds).toContain(jobId);
    expect(repeated.jobIds).toHaveLength(2);
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
    // A non-retryable report is not terminal: the job stays open and backs off.
    const [open] = await getDb(ctx.db)
      .select({ state: imageProcessingJob.state })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    expect(open?.state).toBe("pending");
    const submission = await createImageProcessingSubmission(ctx.db);
    const imageId = parseEntityId("image", source.id);
    // Every open job of the image is retried now, the Apple description too.
    expect(
      await retryImageProcessingNow(ctx.db, {
        imageId,
        submissionId: submission.id,
      }),
    ).toContain(jobId);
    // Retry now is repeatable; membership is recorded once.
    await retryImageProcessingNow(ctx.db, {
      imageId,
      submissionId: submission.id,
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(imageProcessingSubmissionJob)
        .where(eq(imageProcessingSubmissionJob.submissionId, submission.id)),
    ).toHaveLength(2);
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
  it("preserves assignments and rejects a reclaimed attempt's delivery once", async () => {
    const { jobId } = await setup();
    const lease = await claim(jobId);
    const deviceId = parseEntityId("device", crypto.randomUUID());
    const assignment = {
      jobId,
      attemptId: lease.attemptId,
      userId: "test-user",
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
      await findImageProcessingDeviceAssignment(ctx.db, {
        jobId,
        attemptId: lease.attemptId,
        userId: "another-user",
        deviceId,
      }),
    ).toBe(false);
    // The lease expires and another claim replaces the attempt.
    await getDb(ctx.db)
      .update(durableJob)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(durableJob.key, `image-processing:${jobId}`));
    await claim(jobId);
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
    const [recorded] = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, lease.attemptId));
    expect(recorded?.executor?.deviceId).toBe(deviceId);
    // The reclaim expired it; the late skip is an executor failure, so it
    // lands in this attempt's history like any late failure, without
    // touching the newer attempt.
    expect(recorded).toMatchObject({
      state: "failed",
      error: "unsupported_format",
    });
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
    const created = await readDeviceById(ctx.db, deviceEntityId);
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
  // A companion can return after another attempt reclaimed its lease, or after the source changes.
  // Neither a new reservation nor retaining uploaded input may revive that stale attempt.
  it.each(["reclaimed", "stopped", "replaced", "deleted"])(
    "fences analysis input after the source is %s",
    async (change) => {
      const { source, jobId } = await setup();
      const lease = await claim(jobId);
      expect(await assignCloud(jobId, lease.attemptId)).toBe(true);
      const key = `tests/input-${lease.attemptId}.jpg`;
      expect(
        await reserveImageAnalysisInput(ctx.db, lease.attemptId, key),
      ).toBe(true);
      if (change === "reclaimed") {
        await getDb(ctx.db)
          .update(durableJob)
          .set({ leaseExpiresAt: new Date(0) })
          .where(eq(durableJob.key, `image-processing:${jobId}`));
        await claim(jobId);
      } else if (change === "stopped") {
        await getDb(ctx.db)
          .update(durableJob)
          .set({ state: "paused" })
          .where(eq(durableJob.key, `image-processing:${jobId}`));
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
    expect(saved).toMatchObject({
      state: "pending",
      attemptId: lease.attemptId,
    });
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
    expect(saved).toMatchObject({
      state: "pending",
      attemptId: lease.attemptId,
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiAnalysis)
        .where(eq(aiAnalysis.entityId, source.id)),
    ).toEqual([]);
  });
  // Review finding: a device-normalized AVIF reaches the cloud provider from
  // the completion path, whose catch recorded an exhausted AI budget (or a
  // typed provider wait) as a failed attempt with failure backoff. It is a
  // funding wait, like the drain's own cloud dispatch.
  it("waits for AI funding without an attempt when a normalized AVIF meets an exhausted budget", async () => {
    const { source, jobId } = await setup();
    await getDb(ctx.db)
      .update(image)
      .set({ contentType: "image/avif" })
      .where(eq(image.id, source.id));
    const lease = await claim(jobId);
    await assignCloud(jobId, lease.attemptId);
    const key = storage.imageAnalysisKey("staging", lease.attemptId);
    await reserveImageAnalysisInput(ctx.db, lease.attemptId, key);
    // A minimal baseline JPEG: SOI, a 3x2 SOF0 frame, EOI.
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03,
      0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
    ]);
    const resumeAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
    const read = vi
      .spyOn(storage, "getS3Object")
      .mockImplementation(
        async () =>
          new Response(bytes, { headers: { "content-type": "image/jpeg" } }),
      );
    const describe = vi
      .spyOn(cloudDescription, "completeCloudImageDescription")
      .mockRejectedValue(
        new AiBudgetExhaustedError(
          fromPartial<ConstructorParameters<typeof AiBudgetExhaustedError>[0]>({
            windowEnd: resumeAt,
          }),
          "Synthetic AI budget reached",
        ),
      );
    try {
      await completeCompanionImageProcessingResult(ctx.db, {
        jobId,
        attemptId: lease.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "describe_image",
          status: "normalized",
          key,
          contentType: "image/jpeg",
          sha256: await sha256Hex(bytes),
          width: 2,
          height: 3,
        },
      });
      expect(describe).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
      describe.mockRestore();
    }
    const [execution] = await getDb(ctx.db)
      .select()
      .from(durableJob)
      .where(eq(durableJob.key, `image-processing:${jobId}`));
    expect(execution).toMatchObject({
      waitReason: "ai_funding_window",
      attempts: 0,
      leaseToken: null,
    });
    expect(execution?.availableAt.toISOString()).toBe(resumeAt);
    const [attempt] = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, lease.attemptId));
    expect(attempt?.state).toBe("released");
    const [saved] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    expect(saved).toMatchObject({
      state: "pending",
      lastError: "Synthetic AI budget reached",
    });
  });

  it("does not retry skips or work for an obsolete source", async () => {
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
    const imageId = parseEntityId("image", source.id);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, source.id));
    expect(await retryImageProcessingNow(ctx.db, { imageId })).toEqual([]);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "a".repeat(64) })
      .where(eq(image.id, source.id));
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "skipped" })
      .where(eq(imageProcessingJob.id, jobId));
    expect(await retryImageProcessingNow(ctx.db, { imageId })).not.toContain(
      jobId,
    );
  });
  it("adopts cloud analysis only with its live lease and keeps rejected output in attempt history", async () => {
    const { source, jobId } = await setup();
    const old = await claim(jobId);
    await getDb(ctx.db)
      .update(durableJob)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(durableJob.key, `image-processing:${jobId}`));
    await getDb(ctx.db)
      .update(durableJob)
      .set({ availableAt: new Date(0) })
      .where(eq(durableJob.key, `image-processing:${jobId}`));
    const current = await claim(jobId);
    const cloudAnalysis = {
      provider: "test",
      model: "test-vision",
      promptRevision: 1,
      resultSchemaRevision: 1,
      inputFingerprint: "test-input",
    };
    const before = await derivedMarkTickets(
      ctx.db,
      "image.searchDocument",
      source.id,
    );
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
    expect(
      await derivedMarkTickets(ctx.db, "image.searchDocument", source.id),
    ).not.toEqual(before);
  });
});
