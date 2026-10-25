import { parseEntityId, type RunId } from "@cubby/schemas/identifiers";
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
  run,
} from "~/server/db/schema";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { readJobQueue } from "~/server/generic/jobs/repo/job-queue";
import { JOB_BACKFILL_SHARE } from "~/server/generic/jobs/repo/jobs";

import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  releaseAssignedImageProcessingJob,
  releaseImageProcessingLease,
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
  async function job(
    processorRevision: number,
    contentType = "image/jpeg",
    runId: RunId | null = null,
  ) {
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
      runId,
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

  // Review finding: device pulls ordered parked work only by availability,
  // so an active Run's photos waited behind older backfill, and nothing kept
  // backfill's reserved share once Run work led.
  it("serves an active Run's device work before older backfill", async () => {
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const owned = await job(
      IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
      "image/jpeg",
      runId,
    );
    expect((await claim())?.id).toBe(owned);
    expect((await claim())?.id).toBe(backfill);
  });

  it("keeps backfill's reserved share of device pulls while Run work leads", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const owned: string[] = [];
    for (let index = 0; index < 6; index++)
      owned.push(
        await job(
          IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
          "image/jpeg",
          runId,
        ),
      );
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const order: string[] = [];
    for (let pull = 0; pull < 7; pull++) {
      const lease = await claim();
      if (!lease) continue;
      await assign(lease);
      order.push(lease.id);
    }
    expect(order).toHaveLength(7);
    // The drain's share: one slot in every 1 / JOB_BACKFILL_SHARE claims.
    expect(order.indexOf(backfill)).toBeLessThan(
      Math.ceil(1 / JOB_BACKFILL_SHARE),
    );
    expect(order.filter((id) => owned.includes(id))).toHaveLength(6);
  });

  // Review finding: the different-device preference filtered candidates
  // before the owed class was chosen, so a device's own released backfill
  // lost its turn to fresh Run work for as long as Run work kept arriving.
  it("gives a device its own released backfill when backfill's turn comes", async () => {
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const released = await claim();
    if (released?.id !== backfill) throw new Error("Expected backfill lease");
    await assign(released);
    expect(
      await releaseAssignedImageProcessingJob(ctx.db, {
        jobId: released.id,
        attemptId: released.attemptId,
        userId,
        deviceId,
      }),
    ).toBe(true);
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const owned: string[] = [];
    for (let index = 0; index < 5; index++)
      owned.push(
        await job(
          IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
          "image/jpeg",
          runId,
        ),
      );
    const order: string[] = [];
    for (let pull = 0; pull < 5; pull++) {
      const lease = await claim();
      if (!lease) continue;
      await assign(lease);
      order.push(lease.id);
    }
    expect(order).toEqual([...owned.slice(0, 4), backfill]);
  });

  // Review finding: the streak reclassified past services by current Run
  // ownership, so a Run finishing turned its four services into backfill and
  // the next Run began a fresh owned streak while backfill waited.
  it("counts a service by the class it was admitted under", async () => {
    const first = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    for (let index = 0; index < 4; index++) {
      await job(
        IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
        "image/jpeg",
        first,
      );
      const lease = await claim(crypto.randomUUID());
      if (!lease) throw new Error("Expected Run lease");
      await assign(lease);
    }
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, first));
    const next = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION, "image/jpeg", next);
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    expect((await claim(crypto.randomUUID()))?.id).toBe(backfill);
  });

  // Review finding: concurrent pulls at the last owned slot both read the
  // streak before either service was recorded, so both took Run work.
  it("serializes concurrent pulls at backfill's turn", async () => {
    const owner = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    for (let index = 0; index < 3; index++) {
      await job(
        IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
        "image/jpeg",
        owner,
      );
      const lease = await claim(crypto.randomUUID());
      if (!lease) throw new Error("Expected Run lease");
      await assign(lease);
    }
    for (let index = 0; index < 2; index++)
      await job(
        IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
        "image/jpeg",
        owner,
      );
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    // One owned slot remains: of two simultaneous pulls, one serves it and the
    // other is backfill's turn.
    const leases = await Promise.all([
      claim(crypto.randomUUID()),
      claim(crypto.randomUUID()),
    ]);
    expect(leases.map((lease) => lease?.id)).toContain(backfill);
  });

  // Review finding: a backfill claim reset the streak when admitted, so a
  // hand-off the server then refused (participation turned off) released it
  // with the turn spent, and another device served four more Run Jobs first.
  // A refusal now undoes its admission as if the claim had never happened,
  // without overwriting admissions other devices made in between.
  describe("a refused hand-off", () => {
    const runJob = async (owner: RunId) =>
      job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION, "image/jpeg", owner);
    const backfillJob = () => job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    /** Four served Run claims: backfill's turn is next. */
    async function owedBackfill() {
      const owner = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        trigger: "manual",
      });
      for (let index = 0; index < 4; index++) {
        await runJob(owner);
        const lease = await claim(crypto.randomUUID());
        if (!lease) throw new Error("Expected Run lease");
        await assign(lease);
      }
      return owner;
    }
    const refuse = (lease: Awaited<ReturnType<typeof claim>>) =>
      releaseImageProcessingLease(ctx.db, {
        jobId: lease!.id,
        attemptId: lease!.attemptId,
        reason: "Device assignment was refused",
        event: "dispatch.released",
        refusedAdmission: lease!.admission ?? undefined,
      });

    it("keeps backfill owed", async () => {
      const owner = await owedBackfill();
      const backfill = await backfillJob();
      await runJob(owner);
      const refused = await claim(crypto.randomUUID());
      expect(refused).toMatchObject({
        id: backfill,
        admission: { runOwned: false },
      });
      expect(await refuse(refused)).toBe(true);
      expect((await claim(crypto.randomUUID()))?.id).toBe(backfill);
    });

    it("keeps backfill owed past Run claims another device made meanwhile", async () => {
      const owner = await owedBackfill();
      const backfill = await backfillJob();
      const owned = [await runJob(owner), await runJob(owner)];
      const refused = await claim(crypto.randomUUID());
      expect(refused?.id).toBe(backfill);
      // Another device is served while the first hand-off is still settling.
      const other = crypto.randomUUID();
      const served = await claim(other);
      expect(served?.id).toBe(owned[0]);
      await assign(served!, other);
      expect(await refuse(refused)).toBe(true);
      expect((await claim(other))?.id).toBe(backfill);
    });

    it("leaves the turn spent by a backfill another device took meanwhile", async () => {
      const owner = await owedBackfill();
      const first = await backfillJob();
      const second = await backfillJob();
      const refused = await claim(crypto.randomUUID());
      expect(refused?.id).toBe(first);
      // No Run work is due, so the other device takes the second backfill.
      const other = crypto.randomUUID();
      const served = await claim(other);
      expect(served?.id).toBe(second);
      await assign(served!, other);
      const owned = await runJob(owner);
      expect(await refuse(refused)).toBe(true);
      // Backfill already had its turn: Run work leads again.
      expect((await claim(other))?.id).toBe(owned);
    });

    it("gives back a refused Run claim's slot only", async () => {
      const owner = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        trigger: "manual",
      });
      for (let index = 0; index < 3; index++) {
        await runJob(owner);
        const lease = await claim(crypto.randomUUID());
        if (!lease) throw new Error("Expected Run lease");
        await assign(lease);
      }
      const owned = [await runJob(owner), await runJob(owner)];
      const backfill = await backfillJob();
      const refused = await claim(crypto.randomUUID());
      expect(refused).toMatchObject({
        id: owned[0],
        admission: { runOwned: true },
      });
      expect(await refuse(refused)).toBe(true);
      // The fourth Run slot is free again; backfill follows it.
      const next = await claim(crypto.randomUUID());
      expect(next?.admission?.runOwned).toBe(true);
      await assign(next!);
      expect((await claim(crypto.randomUUID()))?.id).toBe(backfill);
    });
  });

  // Review finding: the backfill turn counted any Job with a runId as
  // run-owned and reset only on runId-less claims, while selection owns work
  // by an active, member-visible Run; and it counted rows by their last
  // claim, so reclaims of one row counted once. Service is now one handed-over
  // claim (an assigned attempt), owned by the same definition as selection.
  it("resets the backfill turn when it serves an inactive Run's work", async () => {
    const active = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const finished = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed" })
      .where(eq(run.id, finished));
    const owned: string[] = [];
    for (let index = 0; index < 6; index++)
      owned.push(
        await job(
          IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
          "image/jpeg",
          active,
        ),
      );
    const inactive = await job(
      IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
      "image/jpeg",
      finished,
    );
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const order: string[] = [];
    for (let pull = 0; pull < 8; pull++) {
      const lease = await claim(crypto.randomUUID());
      if (!lease) continue;
      await assign(lease);
      order.push(lease.id);
    }
    // Four Run pulls, then backfill's turn serves the inactive Run's work,
    // which resets the turn: the last two Run pulls precede the next backfill.
    expect(order).toEqual([
      ...owned.slice(0, 4),
      inactive,
      ...owned.slice(4),
      backfill,
    ]);
  });

  it("counts each handed-over reclaim of one row toward the backfill turn", async () => {
    const active = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const owned = await job(
      IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
      "image/jpeg",
      active,
    );
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const order: string[] = [];
    for (let pull = 0; pull < 5; pull++) {
      const device = crypto.randomUUID();
      const lease = await claim(device);
      if (!lease) continue;
      await assign(lease, device);
      order.push(lease.id);
      // The device goes silent; its lease lapses and the next pull reclaims.
      await expire(lease.id);
    }
    expect(order).toEqual([owned, owned, owned, owned, backfill]);
  });

  // Review finding: device queue positions ranked by availability while
  // device claims put active Run work first and reserve backfill a turn.
  it("reports device queue positions in device claim order", async () => {
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const active = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const owned = await job(
      IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
      "image/jpeg",
      active,
    );
    const queue = await readJobQueue(ctx.db, {
      filter: { kinds: ["image.device"] },
      runId: null,
      pageIndex: 0,
      pageSize: 10,
    });
    const ahead = Object.fromEntries(
      queue.jobs.map((row) => [row.key, row.ahead]),
    );
    expect(ahead).toEqual({
      [`image-processing:${owned}`]: 0,
      [`image-processing:${backfill}`]: 1,
    });
    expect((await claim())?.id).toBe(owned);
    expect((await claim())?.id).toBe(backfill);
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
