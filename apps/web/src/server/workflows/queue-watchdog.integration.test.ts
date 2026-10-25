import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  image,
  imageProcessingJob,
  job,
  jobInvalidation,
  jobInvalidationCapture,
  run,
} from "~/server/db/schema";
import {
  createTransparentDerivativeAndJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  imageProcessingLane,
} from "~/server/domains/image-processing/repo/image-processing";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { invalidateRefreshFamily } from "~/server/generic/derived-refresh/repo/families";
import {
  readJobQueue,
  readRunRollups,
  retryJobSet,
} from "~/server/generic/jobs/repo/job-queue";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";
import {
  JOB_RETENTION_MS,
  measureQueueHealth,
  pruneFinishedJobs,
  pruneObservedInvalidationCaptures,
} from "~/server/generic/jobs/repo/queue-health";
import { advanceJob } from "~/server/generic/jobs/service/jobs";

import { explainWaiting } from "./job-explain";
import { productionJobHandlers } from "./jobs";
import { enrollQueueMaintenance, readQueueHealth } from "./queue-watchdog";

describe("queue watchdog, explain and retention", () => {
  const ctx = withTestDb();

  async function subjectLift() {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "object.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const hash = "e".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, row.id));
    const scheduled = await createTransparentDerivativeAndJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      sourceContentHash: hash,
      key: `pending/${crypto.randomUUID()}.png`,
    });
    if (!scheduled) throw new Error("Expected job");
    return { ...scheduled, image: row };
  }
  const execution = async (jobId: string) =>
    (
      await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, `image-processing:${jobId}`))
    )[0]!;
  const runWatchdog = async () => {
    await enrollQueueMaintenance(ctx.db);
    const [watchdog] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "queue.watchdog"));
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, watchdog!.id));
    return advanceJob(ctx.db, watchdog!.id, productionJobHandlers);
  };

  it("keeps the migration's Apple lane revision in step with the code", () => {
    expect(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION).toBe(1985616673);
    expect(
      imageProcessingLane({
        kind: "describe_image",
        processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
        contentType: "image/jpeg",
      }),
    ).toBe("image.device");
  });

  // Production findings: 1,915 rows leased while their Job had failed, and
  // leased rows whose Job lease expired unclaimed.
  it("heals stranded image execution and measures queue health", async () => {
    const exhausted = await subjectLift();
    const expired = await subjectLift();
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "leased", attemptId: crypto.randomUUID() })
      .where(eq(imageProcessingJob.id, exhausted.jobId));
    await getDb(ctx.db)
      .update(job)
      .set({ state: "failed", error: "Job exhausted attempts" })
      .where(eq(job.key, `image-processing:${exhausted.jobId}`));
    const token = crypto.randomUUID();
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "leased", attemptId: token })
      .where(eq(imageProcessingJob.id, expired.jobId));
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "running",
        leaseToken: token,
        leaseExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(job.key, `image-processing:${expired.jobId}`));

    expect(await runWatchdog()).toBe("succeeded");
    const rows = await getDb(ctx.db)
      .select({ id: imageProcessingJob.id, state: imageProcessingJob.state })
      .from(imageProcessingJob);
    expect(rows.every((row) => row.state === "pending")).toBe(true);
    expect(await execution(exhausted.jobId)).toMatchObject({
      state: "queued",
      error: "Job exhausted attempts",
    });
    // The expired lease stays with its token: the next device pull reclaims it.
    expect(await execution(expired.jobId)).toMatchObject({
      state: "running",
      leaseToken: token,
    });
    const health = await readQueueHealth(ctx.db);
    expect(health?.imageDisagreement).toBe(0);
    expect(health?.kinds).toContainEqual(
      expect.objectContaining({
        kind: "image.device",
        lane: "apple_device",
        expiredLeases: 1,
      }),
    );
  });

  it("explains a Run, its image job and a Job, and counts lanes by reason", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const lift = await subjectLift();
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ runId })
      .where(eq(imageProcessingJob.id, lift.jobId));
    await getDb(ctx.db)
      .update(job)
      .set({ runId })
      .where(eq(job.key, `image-processing:${lift.jobId}`));
    const [owner] = await getDb(ctx.db)
      .select({ shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, runId));
    const [row] = await getDb(ctx.db)
      .select({ shortcode: imageProcessingJob.shortcode })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, lift.jobId));

    const forRun = await explainWaiting(ctx.db, owner!.shortcode);
    expect(forRun.steps[0]).toMatchObject({
      kind: "run",
      ref: owner!.shortcode,
    });
    expect(forRun.steps).toContainEqual(
      expect.objectContaining({
        kind: "job",
        waitingOn: expect.objectContaining({ reason: "waiting_device" }),
      }),
    );
    expect(forRun.rollup?.counts).toEqual({ waiting_device: 1 });

    const forImageJob = await explainWaiting(ctx.db, row!.shortcode);
    expect(forImageJob.steps.map((step) => step.kind)).toEqual([
      "imageJob",
      "job",
      "run",
    ]);
    expect(forImageJob.steps[0]).toMatchObject({
      state: "waiting_for_device",
      waitingOn: { reason: "waiting_device", lane: "apple_device" },
    });
    const executionId = (await execution(lift.jobId)).id;
    expect((await explainWaiting(ctx.db, executionId)).steps[0]).toMatchObject({
      kind: "job",
      ref: executionId,
    });
    await expect(explainWaiting(ctx.db, "PRD-SYNTH")).rejects.toMatchObject({
      reason: "EXPLAIN_TARGET_UNSUPPORTED",
    });

    const queue = await readJobQueue(ctx.db, {
      filter: { lanes: ["apple_device"] },
      runId: null,
      pageIndex: 0,
      pageSize: 10,
    });
    expect(queue.counts).toEqual([
      { lane: "apple_device", reason: "waiting_device", count: 1 },
    ]);
    expect(queue.jobs[0]).toMatchObject({
      lane: "apple_device",
      runId: owner!.shortcode,
      waitingOn: { reason: "waiting_device" },
    });
  });

  it("flags a Run whose live Jobs stopped progressing and retries its set now", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const stuck = await enqueueJob(ctx.db, {
      key: "synthetic.stalled",
      kind: "synthetic.stalled",
      input: {},
      runId,
      availableAt: new Date(Date.now() + 60 * 60_000),
    });
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "retry_wait",
        lastClaimedAt: new Date(Date.now() - 60 * 60_000),
      })
      .where(eq(job.id, stuck.id));
    const [owner] = await getDb(ctx.db)
      .select({ id: run.id, shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, runId));
    const [rollup] = await readRunRollups(ctx.db, [owner!]);
    expect(rollup).toMatchObject({
      counts: { backing_off: 1 },
      stalled: true,
      waitingForFunding: false,
    });
    expect(
      await retryJobSet(ctx.db, { reasons: ["backing_off"] }, runId),
    ).toEqual([stuck.id]);
    expect((await readRunRollups(ctx.db, [owner!]))[0]?.counts).toEqual({
      due: 1,
    });
  });

  // Review finding: a completed Job woken by a capture was claimable but
  // health counted it as not due and, once outside the claim window, omitted
  // its kind and raised no alert.
  it("counts an invalidation-woken Job as due in health and alerts when nothing claims it", async () => {
    const search = await enqueueJob(ctx.db, {
      key: "refresh:search",
      kind: "refresh.family",
      input: { family: "search" },
    });
    const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "completed",
        observedRevision: 10,
        lastClaimedAt: longAgo,
        availableAt: longAgo,
      })
      .where(eq(job.id, search.id));
    await getDb(ctx.db)
      .insert(jobInvalidation)
      .values({
        key: "refresh:search",
        revision: 11,
        restartsPass: true,
        updatedAt: new Date(Date.now() - 40 * 60_000),
      })
      .onConflictDoUpdate({
        target: jobInvalidation.key,
        set: { revision: 11, updatedAt: new Date(Date.now() - 40 * 60_000) },
      });
    const health = await measureQueueHealth(ctx.db, {
      previous: null,
      imageDisagreement: 0,
    });
    const family = health.kinds.find((kind) => kind.kind === "refresh.family");
    expect(family).toMatchObject({ due: 1, claimsPerMinute: 0 });
    // Pending since the capture, not since the old availableAt.
    expect(family?.oldestDueSeconds).toBeGreaterThanOrEqual(39 * 60);
    expect(family?.oldestDueSeconds).toBeLessThan(60 * 60);
    expect(health.alerts).toContainEqual(
      expect.objectContaining({ kind: "refresh.family", code: "no_claims" }),
    );
    expect(health.alerts).toContainEqual(
      expect.objectContaining({ kind: "refresh.family", code: "oldest_due" }),
    );
  });

  // Review finding: every capture moved the marker's updatedAt, so a family
  // pending for 45 minutes read as just due after one more capture, and a
  // recent claim of another family of the kind also hid no_claims.
  it("keeps the start of a long-pending invalidation across later captures", async () => {
    const families = await Promise.all(
      (["search", "quality"] as const).map((name) =>
        enqueueJob(ctx.db, {
          key: `refresh:${name}`,
          kind: "refresh.family",
          input: { family: name },
        }),
      ),
    );
    const [search, quality] = families;
    if (!search || !quality) throw new Error("Expected family Jobs");
    const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await getDb(ctx.db)
      .update(job)
      .set({ state: "completed", lastClaimedAt: longAgo, availableAt: longAgo })
      .where(eq(job.id, search.id));
    // Another family of the kind was claimed a minute ago.
    await getDb(ctx.db)
      .update(job)
      .set({ state: "completed", lastClaimedAt: new Date(Date.now() - 60_000) })
      .where(eq(job.id, quality.id));
    const started = Date.now() - 45 * 60_000;
    const captures = [started, started + 20 * 60_000, Date.now() - 30_000];
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const at of captures) {
        vi.setSystemTime(at);
        await invalidateRefreshFamily(ctx.db, "search");
      }
    } finally {
      vi.useRealTimers();
    }
    const health = await measureQueueHealth(ctx.db, {
      previous: null,
      imageDisagreement: 0,
    });
    const family = health.kinds.find((kind) => kind.kind === "refresh.family");
    expect(family).toMatchObject({ due: 1 });
    expect(family?.claimsPerMinute).toBeGreaterThan(0);
    // Pending since the first unobserved capture, not the latest one.
    expect(family?.oldestDueSeconds).toBeGreaterThanOrEqual(44 * 60);
    expect(family?.oldestDueSeconds).toBeLessThan(50 * 60);
    expect(health.alerts).toContainEqual(
      expect.objectContaining({ kind: "refresh.family", code: "oldest_due" }),
    );
    expect(health.alerts).toContainEqual(
      expect.objectContaining({ kind: "refresh.family", code: "no_claims" }),
    );
  });

  it("prunes finished Jobs past retention and keeps failed ones", async () => {
    const old = new Date(Date.now() - JOB_RETENTION_MS - 60_000);
    for (const [key, state] of [
      ["synthetic.old-completed", "completed"],
      ["synthetic.old-failed", "failed"],
    ] as const) {
      const saved = await enqueueJob(ctx.db, { key, kind: key, input: {} });
      await getDb(ctx.db)
        .update(job)
        .set({ state, updatedAt: old })
        .where(eq(job.id, saved.id));
    }
    expect(await pruneFinishedJobs(ctx.db, { limit: 100 })).toBe(1);
    expect(
      (await getDb(ctx.db).select({ key: job.key }).from(job)).map(
        (row) => row.key,
      ),
    ).toContain("synthetic.old-failed");
  });

  it("prunes only capture times every claim of their Job observed", async () => {
    for (let capture = 0; capture < 3; capture++)
      await invalidateRefreshFamily(ctx.db, "search");
    await getDb(ctx.db)
      .update(job)
      .set({ observedRevision: 2 })
      .where(eq(job.key, "refresh:search"));
    expect(
      await pruneObservedInvalidationCaptures(ctx.db, { limit: 100 }),
    ).toBe(2);
    expect(
      await getDb(ctx.db)
        .select({ revision: jobInvalidationCapture.revision })
        .from(jobInvalidationCapture)
        .where(eq(jobInvalidationCapture.key, "refresh:search")),
    ).toEqual([{ revision: 3 }]);
  });
});
