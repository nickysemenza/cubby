import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  getDb,
  withSnapshotWriteDatabase,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { job, jobInvalidation } from "~/server/db/schema";
import {
  claimJob,
  dueJobs,
  enqueueJob,
  failJob,
  publishJobPage,
  renewJob,
} from "~/server/generic/jobs/repo/jobs";

import {
  invalidateRefreshFamily,
  scheduleRefreshFamilies,
  type RefreshFamily,
} from "./families";

// Production finding: a source capture and the family Job's own execution
// wrote one tuple, so claims and renewals on another backend aborted finance
// admission with 40001. Captures now write only `JobInvalidation`; these
// cases pin that the separation loses no rerun.
describe("durable family invalidation", () => {
  const ctx = withTestDb();
  const family = async (name: RefreshFamily) => {
    const saved = await enqueueJob(ctx.db, {
      key: `refresh:${name}`,
      kind: "refresh.family",
      input: { family: name },
    });
    await getDb(ctx.db)
      .update(job)
      .set({ state: "completed" })
      .where(eq(job.id, saved.id));
    return saved;
  };
  const revision = async (name: RefreshFamily) =>
    (
      await getDb(ctx.db)
        .select({ revision: jobInvalidation.revision })
        .from(jobInvalidation)
        .where(eq(jobInvalidation.key, `refresh:${name}`))
    )[0]?.revision ?? 0;
  const row = async (id: string) =>
    (await getDb(ctx.db).select().from(job).where(eq(job.id, id)))[0]!;
  const due = async (id: string) =>
    (await dueJobs(ctx.db, 100)).some((entry) => entry.id === id);

  it("keeps a rolled-back capture out and never loses a committed one", async () => {
    const search = await family("search");
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await invalidateRefreshFamily(tx, "search");
        throw new Error("Synthetic rejected save");
      }),
    ).rejects.toThrow("Synthetic rejected save");
    expect(await revision("search")).toBe(0);
    expect(await due(search.id)).toBe(false);
    await withTransactionDatabase(ctx.db, (tx) =>
      invalidateRefreshFamily(tx, "search"),
    );
    expect(await revision("search")).toBe(1);
    // The completed execution row is untouched, yet the Job is due again.
    expect(await row(search.id)).toMatchObject({
      state: "completed",
      generation: search.generation,
    });
    expect(await due(search.id)).toBe(true);
  });

  it("reruns a capture that landed while a page ran even after the worker died", async () => {
    const search = await family("search");
    await invalidateRefreshFamily(ctx.db, "search");
    const first = await claimJob(ctx.db, search.id);
    if (!first) throw new Error("Expected first claim");
    expect(first.generation).toBe(search.generation + 1);
    await getDb(ctx.db)
      .update(job)
      .set({ cursor: { at: "synthetic-page" } })
      .where(eq(job.id, search.id));
    await invalidateRefreshFamily(ctx.db, "search");
    // The worker vanishes; its lease expires and another claim takes over.
    await getDb(ctx.db)
      .update(job)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(job.id, search.id));
    const reclaimed = await claimJob(ctx.db, search.id);
    expect(reclaimed).toMatchObject({
      generation: first.generation + 1,
      cursor: null,
      observedRevision: await revision("search"),
    });
    // A pass that finishes first (quality) keeps its cursor across a capture
    // and a reclaim, completes, and its scheduled repeat reruns it.
    const quality = await family("quality");
    await invalidateRefreshFamily(ctx.db, "quality");
    const pass = await claimJob(ctx.db, quality.id);
    if (!pass) throw new Error("Expected quality claim");
    await getDb(ctx.db)
      .update(job)
      .set({
        cursor: { at: "synthetic-quality-page" },
        leaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(job.id, quality.id));
    await invalidateRefreshFamily(ctx.db, "quality");
    const resumed = await claimJob(ctx.db, quality.id);
    expect(resumed).toMatchObject({
      generation: pass.generation,
      cursor: { at: "synthetic-quality-page" },
    });
    if (!resumed) throw new Error("Expected quality reclaim");
    expect(await publishJobPage(ctx.db, resumed, { done: true })).toBe(true);
    expect((await row(quality.id)).state).toBe("completed");
    await getDb(ctx.db)
      .update(job)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(job.id, quality.id));
    await scheduleRefreshFamilies(ctx.db, { invalidate: false });
    expect(await due(quality.id)).toBe(true);
  });

  it("never loses a capture that commits while publication runs", async () => {
    const search = await family("search");
    await invalidateRefreshFamily(ctx.db, "search");
    const claim = await claimJob(ctx.db, search.id);
    if (!claim) throw new Error("Expected claim");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const publication = publishJobPage(
      ctx.db,
      claim,
      { done: true },
      async () => {
        entered();
        await gate;
      },
    );
    await inside;
    await invalidateRefreshFamily(ctx.db, "search");
    release();
    await publication;
    // Superseded or finished, the Job reruns for the capture.
    expect(await due(search.id)).toBe(true);
  });

  it("commits a serializable capture while claim, renewal and publication run on another connection", async () => {
    const search = await family("search");
    await invalidateRefreshFamily(ctx.db, "search");
    let attempts = 0;
    await withSnapshotWriteDatabase(
      ctx.db,
      async (tx) => {
        attempts++;
        await getDb(tx).select().from(job).where(eq(job.id, search.id));
        await getDb(tx)
          .select()
          .from(jobInvalidation)
          .where(eq(jobInvalidation.key, "refresh:search"));
        if (attempts === 1) {
          const claim = await claimJob(ctx.db, search.id);
          if (!claim || !(await renewJob(ctx.db, claim)))
            throw new Error("Expected claim and renewal");
          if (
            !(await publishJobPage(ctx.db, claim, {
              done: false,
              cursor: { at: "synthetic-page" },
            }))
          )
            throw new Error("Expected publication");
          const next = await claimJob(ctx.db, search.id);
          if (!next || !(await renewJob(ctx.db, next)))
            throw new Error("Expected second claim and renewal");
        }
        await invalidateRefreshFamily(tx, "search");
      },
      { isolationLevel: "serializable" },
    );
    expect(attempts).toBe(1);
    expect(await revision("search")).toBe(2);
  });

  // Some family pages publish under SERIALIZABLE and read the marker while a
  // serializable admission captures. The capture has already written the
  // marker and stays open while publication starts, reads it and reaches its
  // commit; the two then commit in either order. Publication only reads the
  // marker and the capture never touches the Job row, so no serialization
  // cycle forms and the capture's wake is never lost.
  it.each(["capture commits first", "publication commits first"] as const)(
    "commits a serializable capture overlapping a serializable publication (%s)",
    async (order) => {
      const search = await family("search");
      await invalidateRefreshFamily(ctx.db, "search");
      const claim = await claimJob(ctx.db, search.id);
      if (!claim) throw new Error("Expected claim");
      const before = await revision("search");
      const latch = () => {
        let open: () => void = () => {};
        const opened = new Promise<void>((resolve) => {
          open = resolve;
        });
        return { open, opened };
      };
      const captureWrote = latch();
      const releaseCapture = latch();
      const publicationRead = latch();
      const releasePublication = latch();
      let captures = 0;
      let publications = 0;
      const capture = withSnapshotWriteDatabase(
        ctx.db,
        async (tx) => {
          captures++;
          await invalidateRefreshFamily(tx, "search");
          captureWrote.open();
          await releaseCapture.opened;
        },
        { isolationLevel: "serializable" },
      );
      await captureWrote.opened;
      const publication = publishJobPage(
        ctx.db,
        claim,
        { done: true },
        async () => {
          publications++;
          publicationRead.open();
          await releasePublication.opened;
        },
        "serializable",
      );
      // Both transactions are open: the capture holds its marker write and
      // publication has read the marker under its snapshot.
      await publicationRead.opened;
      if (order === "capture commits first") {
        releaseCapture.open();
        await capture;
        releasePublication.open();
        await publication;
      } else {
        releasePublication.open();
        await publication;
        releaseCapture.open();
        await capture;
      }
      expect(captures).toBe(1);
      expect(publications).toBeGreaterThanOrEqual(1);
      expect(await revision("search")).toBe(before + 1);
      // The page either finished before observing the capture or was
      // superseded by it; either way the family reruns.
      expect(await due(search.id)).toBe(true);
    },
  );

  // Review finding: a page that failed after a capture landed during its
  // pass was marked failed (or backed off) and the captured pass stranded.
  it.each(["exhausted", "retrying"] as const)(
    "starts a fresh pass when a page fails after a capture during its pass (%s)",
    async (budget) => {
      const search = await family("search");
      await invalidateRefreshFamily(ctx.db, "search");
      const claim = await claimJob(ctx.db, search.id);
      if (!claim) throw new Error("Expected claim");
      // The claim is on its last attempt when exhausted.
      const attempts = budget === "exhausted" ? claim.maxAttempts : 1;
      await getDb(ctx.db)
        .update(job)
        .set({ attempts, cursor: { at: "synthetic-page" } })
        .where(eq(job.id, search.id));
      await invalidateRefreshFamily(ctx.db, "search");
      await failJob(
        ctx.db,
        { ...claim, attempts },
        new Error("Synthetic stale-input failure"),
      );
      expect(await row(search.id)).toMatchObject({
        state: "queued",
        attempts: 0,
        cursor: null,
        error: expect.stringContaining("Synthetic stale-input failure"),
      });
      expect(await due(search.id)).toBe(true);
      const fresh = await claimJob(ctx.db, search.id);
      expect(fresh).toMatchObject({
        generation: claim.generation + 1,
        observedRevision: await revision("search"),
      });
    },
  );

  it.each(["paused", "cancelled"] as const)(
    "keeps an explicit member stop (%s) when a capture lands during a failed pass",
    async (stop) => {
      const search = await family("search");
      await invalidateRefreshFamily(ctx.db, "search");
      const claim = await claimJob(ctx.db, search.id);
      if (!claim) throw new Error("Expected claim");
      await getDb(ctx.db)
        .update(job)
        .set({ state: stop })
        .where(eq(job.id, search.id));
      await invalidateRefreshFamily(ctx.db, "search");
      await failJob(ctx.db, claim, new Error("Synthetic late failure"));
      expect((await row(search.id)).state).toBe(stop);
      expect(await due(search.id)).toBe(false);
    },
  );

  // Review finding: failJob and claimJob read the marker, then terminalized
  // the Job as failed in a later statement. A capture committing between the
  // two left a failed Job behind an unobserved restarting revision, and
  // nothing claimed it again. A test-only trigger latches the terminal write
  // so the capture commits exactly inside that window.
  const latchTerminalWrite = async (
    execution: () => Promise<void>,
    between: () => Promise<void>,
  ) => {
    const database = getDb(ctx.db);
    await database.execute(
      sql.raw(`CREATE FUNCTION synthetic_hold_job_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'failed' AND OLD.state <> 'failed' THEN
          PERFORM pg_advisory_xact_lock(424242);
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
    );
    await database.execute(
      sql.raw(`CREATE TRIGGER synthetic_hold_job_failure BEFORE UPDATE ON "Job"
      FOR EACH ROW EXECUTE FUNCTION synthetic_hold_job_failure()`),
    );
    try {
      let pending: Promise<void> | undefined;
      await withTransactionDatabase(ctx.db, async (holder) => {
        const lock = await getDb(holder).execute<{ pid: number }>(
          sql`SELECT pg_advisory_xact_lock(424242), pg_backend_pid() AS pid`,
        );
        const holderPid = lock.rows[0]?.pid;
        if (!holderPid) throw new Error("Expected latch holder");
        pending = execution();
        pending.catch(() => undefined);
        // The execution has read the marker and now waits in its terminal write.
        await expect
          .poll(async () => {
            const waiting = await database.execute<{ waiting: boolean }>(
              sql`SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
              ) AS waiting`,
            );
            return waiting.rows[0]?.waiting;
          })
          .toBe(true);
        await between();
      });
      await pending;
    } finally {
      await database.execute(
        sql.raw(`DROP TRIGGER IF EXISTS synthetic_hold_job_failure ON "Job"`),
      );
      await database.execute(
        sql.raw(`DROP FUNCTION IF EXISTS synthetic_hold_job_failure()`),
      );
    }
  };

  const expectFreshPass = async (id: string, generation: number) => {
    expect(await due(id)).toBe(true);
    const fresh = await claimJob(ctx.db, id);
    expect(fresh).toMatchObject({
      generation: generation + 1,
      attempts: 1,
      cursor: null,
      observedRevision: await revision("search"),
    });
  };

  it("reruns a capture that commits while failJob terminalizes an exhausted pass", async () => {
    const search = await family("search");
    await invalidateRefreshFamily(ctx.db, "search");
    const claim = await claimJob(ctx.db, search.id);
    if (!claim) throw new Error("Expected claim");
    // The claim is on its last attempt, so this failure is terminal.
    await getDb(ctx.db)
      .update(job)
      .set({ attempts: claim.maxAttempts })
      .where(eq(job.id, search.id));
    await latchTerminalWrite(
      () =>
        failJob(
          ctx.db,
          { ...claim, attempts: claim.maxAttempts },
          new Error("Synthetic final failure"),
        ),
      () => invalidateRefreshFamily(ctx.db, "search"),
    );
    // The failure is recorded as it happened; the capture still reruns.
    expect((await row(search.id)).state).toBe("failed");
    await expectFreshPass(search.id, claim.generation);
  });

  it.each(["exhausted", "stalled"] as const)(
    "reruns a capture that commits while a claim terminalizes an %s Job",
    async (cause) => {
      const search = await family("search");
      await invalidateRefreshFamily(ctx.db, "search");
      const claim = await claimJob(ctx.db, search.id);
      if (!claim) throw new Error("Expected claim");
      // The pass was interrupted; its next claim finds it out of budget.
      const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
      await getDb(ctx.db)
        .update(job)
        .set({
          state: "retry_wait",
          availableAt: longAgo,
          leaseToken: null,
          leaseExpiresAt: null,
          ...(cause === "exhausted"
            ? { attempts: claim.maxAttempts }
            : { recoveryTimeoutMs: 60_000, lastUsefulProgressAt: longAgo }),
        })
        .where(eq(job.id, search.id));
      let terminal: Awaited<ReturnType<typeof claimJob>> | undefined;
      await latchTerminalWrite(
        async () => {
          terminal = await claimJob(ctx.db, search.id);
        },
        () => invalidateRefreshFamily(ctx.db, "search"),
      );
      expect(terminal).toBeNull();
      expect((await row(search.id)).state).toBe("failed");
      // The fresh pass gets a fresh budget and recovery window, so it does
      // not fail again at once.
      await expectFreshPass(search.id, claim.generation);
    },
  );
});
