import type { JobId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  claimJob,
  failJob,
  releaseJobClaim,
} from "~/server/generic/jobs/repo/external-claim";
import {
  cancelJobsWhere,
  retryJobsNow,
} from "~/server/generic/jobs/repo/operator";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { dueJobs } from "~/server/generic/jobs/repo/queue";

import {
  deriveJobWaitingOn,
  jobWaitingOnReasonSql,
  loadJobWaitingOn,
} from "./waiting-on";

// Regressions for the 2026-10 queue unclog: image work exhausted its attempt
// budget and stranded leased rows; device churn re-claimed parked work; a
// flood of one kind starved run-owned and other work.
describe("job runtime policy", () => {
  const ctx = withTestDb();
  const read = async (id: JobId) =>
    (await getDb(ctx.db).select().from(job).where(eq(job.id, id)))[0]!;
  const makeDue = (id: JobId) =>
    getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, id));

  it("never exhausts image work: failures back off forever and claims are not attempts", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "image-processing:synthetic-never-exhaust",
      kind: "image.cloud",
      input: {},
      maxAttempts: 1,
    });
    for (let failure = 1; failure <= 6; failure++) {
      await makeDue(saved.id);
      const claim = await claimJob(ctx.db, saved.id);
      if (!claim) throw new Error(`Expected claim ${failure}`);
      // The claim itself is not an attempt.
      expect(claim.attempts).toBe(failure - 1);
      await failJob(ctx.db, claim, new Error("Synthetic provider failure"));
      const row = await read(saved.id);
      expect(row).toMatchObject({ state: "retry_wait", attempts: failure });
      // Capped exponential backoff: 30 s doubling.
      const waitMs = row.availableAt.getTime() - Date.now();
      expect(waitMs).toBeGreaterThan(30_000 * 2 ** (failure - 1) - 5_000);
    }
  });

  it("reclaims a vanished executor's expired lease without counting an attempt", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "image-processing:synthetic-expiry",
      kind: "image.cloud",
      input: {},
      maxAttempts: 1,
    });
    const first = await claimJob(ctx.db, saved.id, 1_000);
    if (!first) throw new Error("Expected claim");
    await getDb(ctx.db)
      .update(job)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(job.id, saved.id));
    const second = await claimJob(ctx.db, saved.id);
    expect(second).toMatchObject({ state: "running", attempts: 0 });
    expect(second?.leaseToken).not.toBe(first.leaseToken);
  });

  it("still fails ordinary kinds after their attempt budget", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.exhausting",
      kind: "synthetic.exhausting",
      input: {},
      maxAttempts: 1,
    });
    const claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Expected claim");
    await failJob(ctx.db, claim, new Error("Synthetic failure"));
    expect((await read(saved.id)).state).toBe("failed");
  });

  it("releases a claim without counting an attempt", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.release",
      kind: "synthetic.release",
      input: {},
    });
    const claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Expected claim");
    expect(await releaseJobClaim(ctx.db, claim)).toBe(true);
    expect(await read(saved.id)).toMatchObject({
      state: "queued",
      leaseToken: null,
    });
    // The released token can no longer release or publish.
    expect(await releaseJobClaim(ctx.db, claim)).toBe(false);
  });

  it("parks device work out of the server drain", async () => {
    const parked = await enqueueJob(ctx.db, {
      key: "image-processing:synthetic-parked",
      kind: "image.device",
      input: {},
    });
    const cloud = await enqueueJob(ctx.db, {
      key: "image-processing:synthetic-cloud",
      kind: "image.cloud",
      input: {},
    });
    const due = (await dueJobs(ctx.db, 25)).map((row) => row.id);
    expect(due).toContain(cloud.id);
    expect(due).not.toContain(parked.id);
  });

  it("serves run-owned Jobs first but keeps a backfill share", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const owned = [];
    for (let index = 0; index < 30; index++)
      owned.push(
        await enqueueJob(ctx.db, {
          key: `synthetic.owned.${index}`,
          kind: "synthetic.owned",
          input: {},
          runId,
        }),
      );
    const backfill = await enqueueJob(ctx.db, {
      key: "synthetic.backfill",
      kind: "synthetic.backfill",
      input: {},
    });
    const batch = await dueJobs(ctx.db, 10);
    expect(batch).toHaveLength(10);
    expect(batch[0]?.kind).toBe("synthetic.owned");
    expect(batch.map((row) => row.id)).toContain(backfill.id);
    // A Run that stopped no longer leads.
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed" })
      .where(eq(run.id, runId));
    expect((await dueJobs(ctx.db, 2)).map((row) => row.kind)).toContain(
      "synthetic.backfill",
    );
  });

  it("retries a filtered set now, keeping prior errors", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.retry-now",
      kind: "synthetic.retry-now",
      input: {},
      maxAttempts: 1,
    });
    const claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Expected claim");
    await failJob(ctx.db, claim, new Error("Synthetic kept error"));
    expect((await read(saved.id)).state).toBe("failed");
    expect(await retryJobsNow(ctx.db, eq(job.id, saved.id))).toEqual([
      saved.id,
    ]);
    const row = await read(saved.id);
    expect(row).toMatchObject({ state: "queued", attempts: 0 });
    expect(row.error).toContain("Synthetic kept error");
    expect(row.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("cancels a large set in one statement", async () => {
    await getDb(ctx.db).execute(sql`
      WITH seeds AS MATERIALIZED (SELECT n, gen_random_uuid() AS id FROM generate_series(1,5000) n), identities AS (
        INSERT INTO "Entity" (id, kind, shortcode) SELECT id, 'job', 'JOB-' || lpad(translate(to_hex(n), '0123456789abcdef', '23456789ABCDEFGH'),10,'2') FROM seeds RETURNING id,shortcode
      ) INSERT INTO "Job" (id,shortcode,key,kind,input)
      SELECT i.id,i.shortcode,'synthetic.bulk-cancel:' || s.n,'synthetic.bulk-cancel','{}'::jsonb FROM identities i JOIN seeds s ON s.id=i.id`);
    const cancelled = await cancelJobsWhere(
      ctx.db,
      eq(job.kind, "synthetic.bulk-cancel"),
    );
    expect(cancelled).toHaveLength(5000);
  });

  it("agrees between the waiting-on derivation and its SQL classifier", async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 60 * 60_000);
    const rows = [
      { key: "due", kind: "synthetic.wait", state: "queued" },
      { key: "device", kind: "image.device", state: "queued" },
      {
        key: "funding",
        kind: "synthetic.wait",
        state: "queued",
        waitReason: "ai_funding_window",
        availableAt: later,
        waitUntil: later,
      },
      {
        key: "backoff",
        kind: "synthetic.wait",
        state: "retry_wait",
        availableAt: later,
      },
      {
        key: "blocked",
        kind: "image.cloud",
        state: "queued",
        waitReason: "device",
        availableAt: later,
      },
      { key: "paused", kind: "synthetic.wait", state: "paused" },
      { key: "done", kind: "synthetic.wait", state: "completed" },
    ] as const;
    for (const row of rows) {
      const created = await enqueueJob(ctx.db, {
        key: `synthetic.waiting.${row.key}`,
        kind: row.kind,
        input: {},
        availableAt: "availableAt" in row ? row.availableAt : now,
      });
      await getDb(ctx.db)
        .update(job)
        .set({
          state: row.state,
          waitReason: "waitReason" in row ? row.waitReason : null,
          waitUntil: "waitUntil" in row ? row.waitUntil : null,
        })
        .where(eq(job.id, created.id));
    }
    const saved = await getDb(ctx.db)
      .select({ row: job, reason: jobWaitingOnReasonSql() })
      .from(job)
      .where(sql`${job.key} LIKE 'synthetic.waiting.%'`);
    const derived = await loadJobWaitingOn(
      ctx.db,
      saved.map((entry) => entry.row),
    );
    const byKey = Object.fromEntries(
      saved.map((entry) => [
        entry.row.key.replace("synthetic.waiting.", ""),
        { sql: entry.reason, ts: derived.get(entry.row.id)?.reason ?? null },
      ]),
    );
    expect(byKey).toEqual({
      due: { sql: "due", ts: "due" },
      device: { sql: "waiting_device", ts: "waiting_device" },
      funding: { sql: "waiting_funding", ts: "waiting_funding" },
      backoff: { sql: "backing_off", ts: "backing_off" },
      blocked: { sql: "blocked", ts: "blocked" },
      paused: { sql: "paused", ts: "paused" },
      done: { sql: null, ts: null },
    });
    expect(
      deriveJobWaitingOn(
        {
          ...saved[0]!.row,
          state: "running",
          leaseExpiresAt: new Date(now.getTime() - 1_000),
        },
        { now, executor: "Synthetic iPad" },
      ),
    ).toMatchObject({
      reason: "leased",
      executor: "Synthetic iPad",
      // Without an assigned device (a cloud executor) there is no device id.
      executorDeviceId: null,
      expired: true,
    });
  });
});
