import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job as durableJob } from "~/server/db/retained-tables";
import {
  image,
  imageProcessingAttempt,
  imageProcessingEvent,
  imageProcessingJob,
} from "~/server/db/schema";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { readJobQueue } from "~/server/generic/jobs/repo/job-queue";

import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  releaseAssignedImageProcessingJob,
  renewAssignedImageProcessingLease,
} from "./image-processing";
import { assignImageProcessingExecutor } from "./image-processing-history";

// Devices claim parked device work directly, honoring its backoff, and never
// steal cloud jobs. A 60 s lease is renewed by heartbeat; release is never an
// attempt and the retry prefers another device; a result after expiry is
// adopted while no newer attempt claimed the work.
describe("background companion leases", () => {
  const ctx = withTestDb();
  const userId = "synthetic-background-user";
  const deviceId = crypto.randomUUID();
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
  const claim = (fromDevice = deviceId) =>
    claimImageProcessingJob(ctx.db, {
      kinds: ["describe_image"],
      leaseMs: 60_000,
      processorRevisions: [IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION],
      deviceId: fromDevice,
    });
  const assign = (
    lease: { id: string; attemptId: string },
    toDevice = deviceId,
  ) =>
    assignImageProcessingExecutor(ctx.db, {
      jobId: lease.id,
      attemptId: lease.attemptId,
      userId,
      executor: {
        kind: "device",
        deviceId: toDevice,
        name: "Test phone",
        platform: "ios",
        appVersion: "1",
        osVersion: "26",
      },
    });
  const expire = (jobId: string) =>
    getDb(ctx.db)
      .update(durableJob)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(durableJob.key, `image-processing:${jobId}`));
  const failure = (lease: { id: string; attemptId: string }) => ({
    result: {
      jobId: lease.id,
      attemptId: lease.attemptId,
      completedAt: new Date().toISOString(),
      outcome: {
        kind: "describe_image" as const,
        status: "failed" as const,
        reason: "Synthetic late device failure",
        retryable: true,
      },
    },
  });

  it("claims parked device work at once but preserves retry backoff", async () => {
    const parked = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const backingOff = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    await getDb(ctx.db)
      .update(durableJob)
      .set({
        state: "retry_wait",
        availableAt: sql`now() + interval '1 hour'`,
      })
      .where(eq(durableJob.key, `image-processing:${backingOff}`));
    const [execution] = await getDb(ctx.db)
      .select({ kind: durableJob.kind })
      .from(durableJob)
      .where(eq(durableJob.key, `image-processing:${parked}`));
    expect(execution?.kind).toBe("image.device");
    const first = await claim();
    expect(first?.id).toBe(parked);
    // Device expiry uses the requested lease owned by Job.
    expect(first!.leaseExpiresAt.getTime() - Date.now()).toBeGreaterThan(
      50_000,
    );
    expect(first!.leaseExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      60_000,
    );
    expect(await claim()).toBeNull();
  });

  // Apple matches its own leases by device id and shows lease age.
  it("names the leasing device and when its lease was claimed in job.queue", async () => {
    const parked = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const lease = await claim();
    if (!lease) throw new Error("Expected lease");
    await assign(lease);
    const [execution] = await getDb(ctx.db)
      .select({ lastClaimedAt: durableJob.lastClaimedAt })
      .from(durableJob)
      .where(eq(durableJob.key, `image-processing:${parked}`));
    const queue = await readJobQueue(ctx.db, {
      filter: { kinds: ["image.device"] },
      runId: null,
      pageIndex: 0,
      pageSize: 10,
    });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.waitingOn).toMatchObject({
      reason: "leased",
      executor: "Test phone",
      executorDeviceId: deviceId,
      leasedAt: execution?.lastClaimedAt?.toISOString(),
      expired: false,
    });
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

  it("releases without an attempt, prefers another device, and keeps a released attempt's late result out", async () => {
    const jobId = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const first = await claim();
    if (!first) throw new Error("Expected lease");
    await assign(first);
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
    const [execution] = await getDb(ctx.db)
      .select({ state: durableJob.state, attempts: durableJob.attempts })
      .from(durableJob)
      .where(eq(durableJob.key, `image-processing:${jobId}`));
    // Due at once, and the release spent nothing.
    expect(execution).toEqual({ state: "queued", attempts: 0 });

    // Another device's work comes first for the device that let this go.
    const other = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    expect((await claim())?.id).toBe(other);
    const second = await claim();
    expect(second?.id).toBe(jobId);
    expect(second?.attemptId).not.toBe(first.attemptId);
    expect(
      (await completeImageProcessingJob(ctx.db, failure(first))).adopted,
    ).toBe(false);
    const [attempt] = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, first.attemptId));
    expect(attempt).toMatchObject({
      state: "released",
      error: "Background execution released",
    });
  });

  it("renews a 60 s lease by heartbeat and refuses a lost or obsolete one", async () => {
    const jobId = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const lease = await claim();
    if (!lease) throw new Error("Expected lease");
    await assign(lease);
    const input = { jobId, attemptId: lease.attemptId, deviceId, userId };
    const renewed = await renewAssignedImageProcessingLease(ctx.db, input);
    expect(renewed).toMatchObject({ ok: true });
    if (!renewed.ok) throw new Error("Expected renewal");
    expect(Date.parse(renewed.leaseExpiresAt) - Date.now()).toBeGreaterThan(
      55_000,
    );
    // An expired lease nobody replaced is still this attempt's.
    await expire(jobId);
    expect(
      await renewAssignedImageProcessingLease(ctx.db, input),
    ).toMatchObject({ ok: true });
    // Another device's heartbeat for this attempt is refused.
    expect(
      await renewAssignedImageProcessingLease(ctx.db, {
        ...input,
        deviceId: crypto.randomUUID(),
      }),
    ).toEqual({ ok: false, reason: "lease_lost" });
    await expire(jobId);
    const replacement = await claim(crypto.randomUUID());
    expect(replacement?.id).toBe(jobId);
    expect(await renewAssignedImageProcessingLease(ctx.db, input)).toEqual({
      ok: false,
      reason: "lease_lost",
    });
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "skipped" })
      .where(eq(imageProcessingJob.id, jobId));
    expect(await renewAssignedImageProcessingLease(ctx.db, input)).toEqual({
      ok: false,
      reason: "job_obsolete",
    });
  });

  it("adopts a late result while no newer attempt claimed it, and records one that came after", async () => {
    const jobId = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const lease = await claim();
    if (!lease) throw new Error("Expected lease");
    await assign(lease);
    await expire(jobId);
    // Late, but nobody reclaimed it: adopted, and the job backs off.
    expect(
      (await completeImageProcessingJob(ctx.db, failure(lease))).adopted,
    ).toBe(true);
    const [execution] = await getDb(ctx.db)
      .select({ state: durableJob.state, attempts: durableJob.attempts })
      .from(durableJob)
      .where(eq(durableJob.key, `image-processing:${jobId}`));
    expect(execution).toEqual({ state: "retry_wait", attempts: 1 });

    await getDb(ctx.db)
      .update(durableJob)
      .set({ availableAt: new Date(0) })
      .where(eq(durableJob.key, `image-processing:${jobId}`));
    const next = await claim();
    if (!next) throw new Error("Expected retry lease");
    await assign(next);
    await expire(jobId);
    const newest = await claim(crypto.randomUUID());
    expect(newest?.id).toBe(jobId);
    // A newer attempt owns it: not adopted, but the failure is history.
    expect(
      (await completeImageProcessingJob(ctx.db, failure(next))).adopted,
    ).toBe(false);
    const [attempt] = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, next.attemptId));
    expect(attempt).toMatchObject({
      state: "failed",
      error: "Synthetic late device failure",
    });
    const events = await getDb(ctx.db)
      .select({
        event: imageProcessingEvent.event,
        level: imageProcessingEvent.level,
      })
      .from(imageProcessingEvent)
      .where(eq(imageProcessingEvent.jobId, jobId));
    expect(events).toContainEqual({
      event: "completion.rejected",
      level: "error",
    });
  });
});
