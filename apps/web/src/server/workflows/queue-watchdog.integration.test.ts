import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import { getDb, withTransaction } from "~/server/db/helpers";
import {
  aiEvaluationRequest,
  image,
  imageProcessingJob,
  job,
  jobInvalidation,
  jobInvalidationCapture,
  entityIdentity,
  run,
} from "~/server/db/schema";
import {
  claimImageProcessingJob,
  createTransparentDerivativeAndJob,
  repairImageProcessingExecution,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  imageProcessingLane,
} from "~/server/domains/image-processing/repo/image-processing";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { NEVER_EXHAUSTED_JOB_KINDS } from "~/server/generic/jobs/kind-policy";
import { claimJob } from "~/server/generic/jobs/repo/external-claim";
import { listRunJobs } from "~/server/generic/jobs/repo/job-diagnostics";
import {
  readJobQueue,
  readRunRollups,
  retryJobSet,
} from "~/server/generic/jobs/repo/job-queue";
import { enqueueJob, repeatJob } from "~/server/generic/jobs/repo/producer";
import {
  jobDue,
  recordJobInvalidation,
} from "~/server/generic/jobs/repo/queue";
import { productionJobHandlers } from "~/server/generic/jobs/repo/queue";
import {
  JOB_RETENTION_MS,
  measureQueueHealth,
  pruneFinishedJobs,
  pruneObservedInvalidationCaptures,
} from "~/server/generic/jobs/repo/queue-health";
import { advanceJob } from "~/server/generic/jobs/service/jobs";

import { explainWaiting } from "./job-explain";
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
    // Image work never ends failed: the database stored the older build's
    // failure as a backoff, which repair leaves with its error.
    expect(await execution(exhausted.jobId)).toMatchObject({
      state: "retry_wait",
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

  // Review finding: device work an older build backed off across the
  // cutover had no wake armed; the drain never claims device work, an early
  // pull found nothing, and the work idled until an unrelated ring.
  it("arms the device wake for device work backing off without one", async () => {
    const lift = await subjectLift();
    const later = new Date(Date.now() + 10 * 60_000);
    // The older build's failure: the database keeps it as a backoff.
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "failed",
        attempts: 2,
        error: "Synthetic older-build failure",
        availableAt: later,
      })
      .where(eq(job.key, `image-processing:${lift.jobId}`));
    await getDb(ctx.db).delete(job).where(eq(job.key, "image.device.wake"));
    await getDb(ctx.db)
      .delete(jobInvalidation)
      .where(eq(jobInvalidation.key, "image.device.wake"));
    // An early pull finds nothing.
    expect(
      await claimImageProcessingJob(ctx.db, {
        kinds: ["subject_lift"],
        leaseMs: 60_000,
        processorRevisions: [IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION],
      }),
    ).toBeNull();
    expect(await runWatchdog()).toBe("succeeded");
    const [wake] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "image.device.wake"));
    if (!wake) throw new Error("Expected the device wake");
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, wake.id));
    await advanceJob(ctx.db, wake.id, productionJobHandlers);
    // The wake sleeps until the work comes due; the work keeps its counters.
    const [scheduled] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, wake.id));
    expect(scheduled?.availableAt.getTime()).toBe(later.getTime());
    expect(await execution(lift.jobId)).toMatchObject({
      state: "retry_wait",
      attempts: 2,
      error: "Synthetic older-build failure",
    });
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(eq(job.key, `image-processing:${lift.jobId}`));
    expect(
      await claimImageProcessingJob(ctx.db, {
        kinds: ["subject_lift"],
        leaseMs: 60_000,
        processorRevisions: [IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION],
      }),
    ).toMatchObject({ id: lift.jobId });
    expect((await execution(lift.jobId)).attempts).toBe(2);
  });

  // Review finding: the watchdog armed the wake outside a transaction, so a
  // failure after the first marker committed but before its Job was created
  // left a marker whose later revisions never create the Job.
  it("creates the device wake on a later tick after a failed first arm", async () => {
    const lift = await subjectLift();
    await getDb(ctx.db)
      .update(job)
      .set({ state: "retry_wait", availableAt: new Date(Date.now() + 60_000) })
      .where(eq(job.key, `image-processing:${lift.jobId}`));
    await getDb(ctx.db).delete(job).where(eq(job.key, "image.device.wake"));
    await getDb(ctx.db)
      .delete(jobInvalidation)
      .where(eq(jobInvalidation.key, "image.device.wake"));
    const database = getDb(ctx.db);
    await database.execute(
      sql.raw(`CREATE FUNCTION synthetic_reject_wake() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic wake enqueue failure'; END $$ LANGUAGE plpgsql`),
    );
    await database.execute(
      sql.raw(`CREATE TRIGGER synthetic_reject_wake BEFORE INSERT ON "Job"
      FOR EACH ROW WHEN (NEW.key = 'image.device.wake')
      EXECUTE FUNCTION synthetic_reject_wake()`),
    );
    try {
      await expect(repairImageProcessingExecution(ctx.db, 25)).rejects.toThrow(
        "Failed query",
      );
    } finally {
      await database.execute(
        sql.raw(`DROP TRIGGER IF EXISTS synthetic_reject_wake ON "Job"`),
      );
      await database.execute(
        sql.raw(`DROP FUNCTION IF EXISTS synthetic_reject_wake()`),
      );
    }
    await repairImageProcessingExecution(ctx.db, 25);
    expect(
      await getDb(ctx.db)
        .select({ id: job.id })
        .from(job)
        .where(eq(job.key, "image.device.wake")),
    ).toHaveLength(1);
  });

  // The migration's guard trigger names the never-exhausted kinds; a kind
  // added to the policy must be added to it in a migration.
  it("keeps the never-exhausted failure trigger in step with the policy", async () => {
    const result = await getDb(ctx.db).execute<{ source: string }>(
      sql`SELECT prosrc AS source FROM pg_proc WHERE proname = 'job_never_exhausted_failure'`,
    );
    const kinds = [...(result.rows[0]?.source ?? "").matchAll(/'([a-z.]+)'/g)]
      .map((match) => match[1])
      .filter((kind) => kind !== "retry_wait");
    expect(kinds.sort()).toEqual([...NEVER_EXHAUSTED_JOB_KINDS].sort());
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

  // Review finding: rollups counted an expired lease as leased, and any
  // leased count suppressed `stalled`, so a Run whose only executor died
  // never read as stalled.
  it("separates expired from live leases in a Run's rollup and its stall", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const abandoned = await enqueueJob(ctx.db, {
      key: "synthetic.abandoned",
      kind: "synthetic.abandoned",
      input: {},
      runId,
    });
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "running",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 30 * 60_000),
        lastClaimedAt: hourAgo,
      })
      .where(eq(job.id, abandoned.id));
    await getDb(ctx.db)
      .update(run)
      .set({ startedAt: hourAgo })
      .where(eq(run.id, runId));
    const [owner] = await getDb(ctx.db)
      .select({ id: run.id, shortcode: run.shortcode })
      .from(run)
      .where(eq(run.id, runId));
    const [expired] = await readRunRollups(ctx.db, [owner!]);
    expect(expired?.counts.leased).toBeUndefined();
    expect(expired).toMatchObject({ expiredLeases: 1, stalled: true });
    // A live lease is progress in flight: counted as leased, not stalled.
    await getDb(ctx.db)
      .update(job)
      .set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(job.id, abandoned.id));
    const [live] = await readRunRollups(ctx.db, [owner!]);
    expect(live).toMatchObject({
      counts: { leased: 1 },
      expiredLeases: 0,
      stalled: false,
    });
  });

  // Review finding: rollups, explain and job.queue matched a Run's work by
  // Job.runId, but AI evaluation Jobs carry none (one evaluation can serve
  // several Runs), so a Run's queued evaluations vanished from all three.
  it("attributes AI evaluation Jobs to every Run that owns or still requests them", async () => {
    const runs = [];
    for (let index = 0; index < 3; index++)
      runs.push(
        await ensureRun(ctx.db, ctx.actor, {
          purpose: "ai_suggest",
          trigger: "manual",
          execution: false,
        }),
      );
    const [owner, requester, withdrawn] = runs as [RunId, RunId, RunId];
    // Shared work names one target: its slot holds one open evaluation.
    const recordId = crypto.randomUUID();
    const evaluation = (runId: RunId) =>
      enqueueAiEvaluation(ctx.db, {
        runId,
        executionKind: "suggestion_sweep",
        shareKey: "synthetic-shared-evaluation",
        feature: "field-suggestion",
        target: {
          kind: "field",
          entity: "product",
          recordId,
          field: "categoryId",
          assessmentIds: [],
        },
        provenance: {
          dependencies: [],
          inputFingerprint: "synthetic-input",
          optionFingerprint: "synthetic-options",
          model: null,
        },
        snapshot: {},
        state: "queued",
      });
    const shared = await evaluation(owner);
    for (const runId of [requester, withdrawn])
      expect((await evaluation(runId)).id).toBe(shared.id);
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ cancelledAt: new Date() })
      .where(eq(aiEvaluationRequest.runId, withdrawn));
    const owners = await getDb(ctx.db)
      .select({ id: run.id, shortcode: run.shortcode })
      .from(run)
      .where(inArray(run.id, runs));
    const byId = new Map(owners.map((row) => [row.id, row]));
    const rollups = await readRunRollups(
      ctx.db,
      runs.map((id) => byId.get(id)!),
    );
    // Owned and requested once each, counted once per Run; a withdrawn
    // request no longer counts.
    expect(rollups.map((rollup) => rollup.counts)).toEqual([
      { due: 1 },
      { due: 1 },
      {},
    ]);
    const queue = await readJobQueue(ctx.db, {
      filter: {},
      runId: requester,
      pageIndex: 0,
      pageSize: 10,
    });
    expect(queue.jobs.map((row) => row.key)).toEqual([
      `ai-evaluation:${shared.id}`,
    ]);
    // job.list for the Run shows the evaluation's fan-out group too.
    const listed = await listRunJobs(ctx.db, byId.get(requester)!.shortcode);
    expect(listed.groups.map((group) => group.kind)).toContain("ai.evaluation");
    const explained = await explainWaiting(ctx.db, byId.get(owner)!.shortcode);
    expect(explained.steps.map((step) => step.label)).toContainEqual(
      expect.stringContaining(`ai-evaluation:${shared.id}`),
    );
  });

  // Review finding: a completed Job woken by a capture was claimable but
  // health counted it as not due and, once outside the claim window, omitted
  // its kind and raised no alert.
  it("counts an invalidation-woken Job as due in health and alerts when nothing claims it", async () => {
    const search = await enqueueJob(ctx.db, {
      key: "derived:drain",
      kind: "derived.drain",
      input: {},
    });
    const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "completed",
        lastClaimedAt: longAgo,
        availableAt: longAgo,
        updatedAt: longAgo,
      })
      .where(eq(job.id, search.id));
    await getDb(ctx.db)
      .insert(jobInvalidation)
      .values({ key: "derived:drain", restartsPass: true })
      .onConflictDoNothing();
    await getDb(ctx.db)
      .insert(jobInvalidationCapture)
      .values({
        key: "derived:drain",
        capturedAt: new Date(Date.now() - 40 * 60_000),
      });
    const health = await measureQueueHealth(ctx.db, {
      previous: null,
      imageDisagreement: 0,
    });
    const family = health.kinds.find((kind) => kind.kind === "derived.drain");
    expect(family).toMatchObject({ due: 1, claimsPerMinute: 0 });
    // Pending since the capture, not since the old availableAt.
    expect(family?.oldestDueSeconds).toBeGreaterThanOrEqual(39 * 60);
    expect(family?.oldestDueSeconds).toBeLessThan(60 * 60);
    expect(health.alerts).toContainEqual(
      expect.objectContaining({ kind: "derived.drain", code: "no_claims" }),
    );
    expect(health.alerts).toContainEqual(
      expect.objectContaining({ kind: "derived.drain", code: "oldest_due" }),
    );
    // Retained completed Jobs outnumber live work: a correlated capture test
    // under OR read every one, and production health reads took 20-180 s.
    // The woken Job must be reached by key, not by testing each retained row.
    const retained = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        enqueueJob(ctx.db, {
          key: `synthetic:retained:${index}`,
          kind: "embedding.refresh",
          input: {},
        }),
      ),
    );
    await getDb(ctx.db)
      .update(job)
      .set({ state: "completed", updatedAt: longAgo })
      .where(
        inArray(
          job.id,
          retained.map((row) => row.id),
        ),
      );
    const plan = await withTransaction(ctx.db, async (tx) => {
      await tx.execute(sql`ANALYZE "Job"`);
      // A table this small is cheaper to scan whole; production's is not.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      return tx.execute(
        sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM "Job" WHERE ${jobDue(new Date())}`,
      );
    });
    const node = z.object({
      "Relation Name": z.string().optional(),
      "Actual Rows": z.number(),
      "Rows Removed by Filter": z.number().default(0),
      Plans: z.array(z.unknown()).optional(),
    });
    let jobRowsRead = 0;
    const visit = (value: unknown) => {
      const parsed = node.parse(value);
      if (parsed["Relation Name"] === "Job")
        jobRowsRead += parsed["Actual Rows"] + parsed["Rows Removed by Filter"];
      parsed.Plans?.forEach(visit);
    };
    z.array(
      z.object({ "QUERY PLAN": z.array(z.object({ Plan: z.unknown() })) }),
    )
      .parse(plan.rows)
      .forEach((row) => row["QUERY PLAN"].forEach(({ Plan }) => visit(Plan)));
    expect(jobRowsRead).toBe(1);
  });

  // Review finding: every capture moved the marker's updatedAt, so a family
  // pending for 45 minutes read as just due after one more capture, and a
  // recent claim of another drain of the kind also hid no_claims.
  it("keeps the start of a long-pending invalidation across later captures", async () => {
    const families = await Promise.all(
      (["drain", "synthetic-other-drain"] as const).map((name) =>
        enqueueJob(ctx.db, {
          key: `derived:${name}`,
          kind: "derived.drain",
          input: {},
        }),
      ),
    );
    const [search, quality] = families;
    if (!search || !quality) throw new Error("Expected family Jobs");
    const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "completed",
        lastClaimedAt: longAgo,
        availableAt: longAgo,
        updatedAt: longAgo,
      })
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
        await recordJobInvalidation(ctx.db, {
          key: "derived:drain",
          kind: "derived.drain",
          input: {},
          restartsPass: false,
        });
      }
    } finally {
      vi.useRealTimers();
    }
    const health = await measureQueueHealth(ctx.db, {
      previous: null,
      imageDisagreement: 0,
    });
    const family = health.kinds.find((kind) => kind.kind === "derived.drain");
    expect(family).toMatchObject({ due: 1 });
    expect(family?.claimsPerMinute).toBeGreaterThan(0);
    // Pending since the first unobserved capture, not the latest one.
    expect(family?.oldestDueSeconds).toBeGreaterThanOrEqual(44 * 60);
    expect(family?.oldestDueSeconds).toBeLessThan(50 * 60);
    expect(health.alerts).toContainEqual(
      expect.objectContaining({ kind: "derived.drain", code: "oldest_due" }),
    );
    expect(health.alerts).toContainEqual(
      expect.objectContaining({ kind: "derived.drain", code: "no_claims" }),
    );
  });

  // Review finding: a derived pass in progress keeps its cursor through
  // captures and is served on its availability, yet health dated it from the
  // oldest capture it will absorb, so a family publishing pages every minute
  // read as stalled.
  it("dates a derived pass in progress by its availability", async () => {
    const search = await enqueueJob(ctx.db, {
      key: "derived:drain",
      kind: "derived.drain",
      input: {},
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() - 40 * 60_000);
      await recordJobInvalidation(ctx.db, {
        key: "derived:drain",
        kind: "derived.drain",
        input: {},
        restartsPass: false,
      });
    } finally {
      vi.useRealTimers();
    }
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "queued",
        cursor: { at: "synthetic-later-page" },
        lastClaimedAt: new Date(Date.now() - 30_000),
        availableAt: new Date(Date.now() - 30_000),
      })
      .where(eq(job.id, search.id));
    const health = await measureQueueHealth(ctx.db, {
      previous: null,
      imageDisagreement: 0,
    });
    const family = health.kinds.find((kind) => kind.kind === "derived.drain");
    expect(family).toMatchObject({ due: 1 });
    expect(family?.oldestDueSeconds).toBeLessThan(5 * 60);
    expect(health.alerts).not.toContainEqual(
      expect.objectContaining({ kind: "derived.drain", code: "oldest_due" }),
    );
  });

  // Review finding: the catch-up requeued a finished family that a capture
  // made during its pass had already made due, and the requeued row was
  // dated from that capture, not from the pass's completion: a false
  // oldest_due 40 minutes after a pass that finished 3 minutes ago.
  it("keeps a follow-up pass dated from completion through the catch-up", async () => {
    const search = await enqueueJob(ctx.db, {
      key: "derived:drain",
      kind: "derived.drain",
      input: {},
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() - 40 * 60_000);
      await recordJobInvalidation(ctx.db, {
        key: "derived:drain",
        kind: "derived.drain",
        input: {},
        restartsPass: false,
      });
    } finally {
      vi.useRealTimers();
    }
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "completed",
        lastClaimedAt: new Date(Date.now() - 3 * 60_000),
        updatedAt: new Date(Date.now() - 3 * 60_000),
      })
      .where(eq(job.id, search.id));
    // The catch-up also enqueues the other drains, each due now.
    await repeatJob(ctx.db, {
      key: "derived:drain",
      kind: "derived.drain",
      input: {},
    });
    const health = await measureQueueHealth(ctx.db, {
      previous: null,
      imageDisagreement: 0,
    });
    const family = health.kinds.find((kind) => kind.kind === "derived.drain");
    expect(family?.oldestDueSeconds).toBeLessThan(5 * 60);
    expect(health.alerts).not.toContainEqual(
      expect.objectContaining({ kind: "derived.drain", code: "oldest_due" }),
    );
  });

  // A pass that ran through a capture finishes due for a full pass; it is
  // due since it finished, not since the capture it ran through.
  it("dates a follow-up pass from the finish of the pass it follows", async () => {
    const search = await enqueueJob(ctx.db, {
      key: "derived:drain",
      kind: "derived.drain",
      input: {},
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() - 40 * 60_000);
      await recordJobInvalidation(ctx.db, {
        key: "derived:drain",
        kind: "derived.drain",
        input: {},
        restartsPass: false,
      });
    } finally {
      vi.useRealTimers();
    }
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "completed",
        lastClaimedAt: new Date(Date.now() - 60_000),
        updatedAt: new Date(Date.now() - 60_000),
      })
      .where(eq(job.id, search.id));
    const health = await measureQueueHealth(ctx.db, {
      previous: null,
      imageDisagreement: 0,
    });
    const family = health.kinds.find((kind) => kind.kind === "derived.drain");
    expect(family).toMatchObject({ due: 1 });
    expect(family?.oldestDueSeconds).toBeLessThan(5 * 60);
  });

  // Review finding: the periodic catch-up (`repeatJob`) requeues a finished
  // family with availability "now" without serving it, which erased the
  // pending age of a capture the family had not observed yet.
  it("keeps a woken drain's pending age through the catch-up", async () => {
    const search = await enqueueJob(ctx.db, {
      key: "derived:drain",
      kind: "derived.drain",
      input: {},
    });
    const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "completed",
        lastClaimedAt: longAgo,
        availableAt: longAgo,
        updatedAt: longAgo,
      })
      .where(eq(job.id, search.id));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() - 45 * 60_000);
      await recordJobInvalidation(ctx.db, {
        key: "derived:drain",
        kind: "derived.drain",
        input: {},
        restartsPass: false,
      });
    } finally {
      vi.useRealTimers();
    }
    await repeatJob(ctx.db, {
      key: "derived:drain",
      kind: "derived.drain",
      input: {},
    });
    // Already due through the capture, so the catch-up leaves it as it is.
    const [kept] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, search.id));
    expect(kept?.state).toBe("completed");
    const health = await measureQueueHealth(ctx.db, {
      previous: null,
      imageDisagreement: 0,
    });
    const family = health.kinds.find((kind) => kind.kind === "derived.drain");
    // The capture, 45 minutes ago, still dates the work past the deadline.
    expect(family?.oldestDueSeconds).toBeGreaterThanOrEqual(44 * 60);
    expect(health.alerts).toContainEqual(
      expect.objectContaining({ kind: "derived.drain", code: "oldest_due" }),
    );
  });

  it("prunes finished Jobs past retention and keeps failed ones", async () => {
    const old = new Date(Date.now() - JOB_RETENTION_MS - 60_000);
    const identities: string[] = [];
    for (const [key, state] of [
      ["synthetic.old-completed", "completed"],
      ["synthetic.old-failed", "failed"],
    ] as const) {
      const saved = await enqueueJob(ctx.db, { key, kind: key, input: {} });
      identities.push(saved.id);
      await getDb(ctx.db)
        .update(job)
        .set({ state, updatedAt: old })
        .where(eq(job.id, saved.id));
    }
    expect(await pruneFinishedJobs(ctx.db, { limit: 100 })).toBe(1);
    expect(
      (
        await getDb(ctx.db)
          .select({ id: entityIdentity.id })
          .from(entityIdentity)
          .where(inArray(entityIdentity.id, identities))
      ).map((row) => row.id),
    ).toEqual([identities[1]]);
    expect(
      (await getDb(ctx.db).select({ key: job.key }).from(job)).map(
        (row) => row.key,
      ),
    ).toContain("synthetic.old-failed");
  });

  it("prunes acknowledged captures while preserving later pending input", async () => {
    for (let capture = 0; capture < 2; capture++)
      await recordJobInvalidation(ctx.db, {
        key: "synthetic:derived-retention",
        kind: "derived.drain",
        input: {},
        restartsPass: false,
      });
    const [search] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "synthetic:derived-retention"));
    if (!search) throw new Error("Expected search Job");
    expect(await claimJob(ctx.db, search.id)).not.toBeNull();
    await recordJobInvalidation(ctx.db, {
      key: "synthetic:derived-retention",
      kind: "derived.drain",
      input: {},
      restartsPass: false,
    });
    const pending = await getDb(ctx.db)
      .select()
      .from(jobInvalidationCapture)
      .where(
        sql`${jobInvalidationCapture.key} = 'synthetic:derived-retention' AND NOT ${jobInvalidationCapture.observed}`,
      );
    expect(pending).toHaveLength(1);
    expect(
      await pruneObservedInvalidationCaptures(ctx.db, { limit: 100 }),
    ).toBe(2);
    expect(
      await getDb(ctx.db)
        .select()
        .from(jobInvalidationCapture)
        .where(eq(jobInvalidationCapture.key, "synthetic:derived-retention")),
    ).toEqual(pending);
  });
});
