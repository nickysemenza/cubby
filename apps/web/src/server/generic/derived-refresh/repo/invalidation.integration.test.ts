import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  getDb,
  withSnapshotWriteDatabase,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  job,
  jobInvalidation,
  jobInvalidationCapture,
} from "~/server/db/schema";
import {
  claimJob,
  dueJobs,
  enqueueJob,
  failJob,
  publishJobPage,
  recordJobInvalidation,
  renewJob,
} from "~/server/generic/jobs/repo/jobs";
import { pruneObservedInvalidationCaptures } from "~/server/generic/jobs/repo/queue-health";

import {
  invalidateRefreshFamily,
  scheduleRefreshFamilies,
  type RefreshFamily,
} from "./families";

// Production finding: a source capture and the family Job's own execution
// wrote one tuple, so claims and renewals on another backend aborted finance
// admission with 40001. Captures now append independent rows; these
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
  // Refresh families no longer restart on capture; a synthetic kind keeps
  // the restarting marker's contract pinned (image.device.wake uses it).
  const RESTARTING = {
    key: "synthetic:restarting",
    kind: "synthetic.restarting",
    input: {},
  };
  const restarting = async () => {
    const saved = await enqueueJob(ctx.db, RESTARTING);
    await getDb(ctx.db)
      .update(job)
      .set({ state: "completed" })
      .where(eq(job.id, saved.id));
    return saved;
  };
  const capture = (db: Parameters<typeof recordJobInvalidation>[0]) =>
    recordJobInvalidation(db, { ...RESTARTING, restartsPass: true });
  const captureCount = async (key: string) =>
    (
      await getDb(ctx.db)
        .select({ count: sql<number>`count(*)::int` })
        .from(jobInvalidationCapture)
        .where(eq(jobInvalidationCapture.key, key))
    )[0]?.count ?? 0;
  const row = async (id: string) =>
    (await getDb(ctx.db).select().from(job).where(eq(job.id, id)))[0]!;
  const due = async (id: string) =>
    (await dueJobs(ctx.db, 100)).some((entry) => entry.id === id);

  // A regressed overlap must reject before Vitest teardown so finally can
  // release and drain the transaction deliberately held by the test.
  const claimWithSqlTimeout = (id: string) =>
    withTransactionDatabase(ctx.db, async (tx) => {
      await getDb(tx).execute(sql`SET LOCAL statement_timeout = '2s'`);
      return claimJob(tx, id);
    });
  const captureWithSqlTimeout = () =>
    withSnapshotWriteDatabase(
      ctx.db,
      async (tx) => {
        await getDb(tx).execute(sql`SET LOCAL statement_timeout = '2s'`);
        await capture(tx);
      },
      { isolationLevel: "serializable" },
    );

  it("keeps an earlier-started capture pending when it commits after a later capture was acknowledged", async () => {
    const marked = await restarting();
    await capture(ctx.db);
    const initial = await claimJob(ctx.db, marked.id);
    if (!initial) throw new Error("Expected initial claim");
    await publishJobPage(ctx.db, initial, { done: true });
    const captured = Promise.withResolvers<void>();
    const mayCommit = Promise.withResolvers<void>();
    const earlier = withSnapshotWriteDatabase(
      ctx.db,
      async (tx) => {
        await capture(tx);
        captured.resolve();
        await mayCommit.promise;
      },
      { isolationLevel: "serializable" },
    );
    void earlier.catch(captured.reject);
    try {
      await captured.promise;
      await captureWithSqlTimeout();
      const later = await claimWithSqlTimeout(marked.id);
      if (!later) throw new Error("Expected later capture claim");
      expect(await publishJobPage(ctx.db, later, { done: true })).toBe(true);
      expect(await due(marked.id)).toBe(false);
      mayCommit.resolve();
      await earlier;
      expect(await due(marked.id)).toBe(true);
      const pending = await getDb(ctx.db)
        .select()
        .from(jobInvalidationCapture)
        .where(
          sql`${jobInvalidationCapture.key} = ${RESTARTING.key} AND NOT ${jobInvalidationCapture.observed}`,
        );
      expect(pending).toHaveLength(1);
      const fresh = await claimJob(ctx.db, marked.id);
      expect(fresh?.generation).toBe(later.generation + 1);
    } finally {
      mayCommit.resolve();
      await earlier;
    }
  });

  it("rolls capture acknowledgement back with an abandoned claim", async () => {
    const marked = await restarting();
    await capture(ctx.db);
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        const claim = await claimJob(tx, marked.id);
        if (!claim) throw new Error("Expected transactional claim");
        throw new Error("Synthetic abandoned claim");
      }),
    ).rejects.toThrow("Synthetic abandoned claim");
    expect(await row(marked.id)).toMatchObject({
      state: "completed",
      generation: marked.generation,
    });
    expect(await due(marked.id)).toBe(true);
    const pending = await getDb(ctx.db)
      .select()
      .from(jobInvalidationCapture)
      .where(
        sql`${jobInvalidationCapture.key} = ${RESTARTING.key} AND NOT ${jobInvalidationCapture.observed}`,
      );
    expect(pending).toHaveLength(1);
  });

  it.each(["serializable", "read committed"] as const)(
    "preserves simultaneous first-key initialization at %s",
    async (isolationLevel) => {
      const input = {
        key: "synthetic:first-capture",
        kind: "synthetic.first-capture",
        input: {},
        restartsPass: true,
      };
      const prepared = Promise.withResolvers<void>();
      const mayCommit = Promise.withResolvers<void>();
      const first = withTransactionDatabase(
        ctx.db,
        async (tx) => {
          await recordJobInvalidation(tx, input);
          prepared.resolve();
          await mayCommit.promise;
        },
        { isolationLevel },
      );
      void first.catch(prepared.reject);
      await prepared.promise;
      const backend = Promise.withResolvers<number>();
      let attempts = 0;
      const secondWork = async (tx: Parameters<typeof claimJob>[0]) => {
        attempts++;
        const result = await getDb(tx).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        const pid = result.rows[0]?.pid;
        if (!pid) throw new Error("Missing second capture backend");
        backend.resolve(pid);
        await recordJobInvalidation(tx, input);
      };
      const second =
        isolationLevel === "serializable"
          ? withSnapshotWriteDatabase(ctx.db, secondWork, { isolationLevel })
          : withTransactionDatabase(ctx.db, secondWork, { isolationLevel });
      void second.catch(backend.reject);
      try {
        const pid = await backend.promise;
        await vi.waitFor(
          async () => {
            const result = await getDb(ctx.db).execute<{ waiting: boolean }>(
              sql`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`,
            );
            expect(result.rows[0]?.waiting).toBe(true);
          },
          { timeout: 5000 },
        );
        mayCommit.resolve();
        await Promise.all([first, second]);
        expect(attempts).toBe(isolationLevel === "serializable" ? 2 : 1);
        expect(
          await getDb(ctx.db).select().from(job).where(eq(job.key, input.key)),
        ).toHaveLength(1);
        expect(
          await getDb(ctx.db)
            .select()
            .from(jobInvalidation)
            .where(eq(jobInvalidation.key, input.key)),
        ).toEqual([{ key: input.key, restartsPass: true }]);
        const captures = await getDb(ctx.db)
          .select()
          .from(jobInvalidationCapture)
          .where(eq(jobInvalidationCapture.key, input.key));
        expect(captures).toHaveLength(2);
        expect(new Set(captures.map((c) => c.id)).size).toBe(2);
        expect(captures.every((c) => !c.observed)).toBe(true);
      } finally {
        mayCommit.resolve();
        await Promise.allSettled([first, second]);
      }
    },
  );

  it("prunes observed input while new capture and claim commit on other connections", async () => {
    const marked = await restarting();
    await capture(ctx.db);
    await capture(ctx.db);
    const initial = await claimJob(ctx.db, marked.id);
    if (!initial) throw new Error("Expected initial claim");
    await publishJobPage(ctx.db, initial, { done: true });
    const pruned = Promise.withResolvers<void>();
    const mayCommit = Promise.withResolvers<void>();
    const pruning = withTransactionDatabase(ctx.db, async (tx) => {
      await getDb(tx).execute(sql`SET LOCAL statement_timeout = '2s'`);
      expect(await pruneObservedInvalidationCaptures(tx, { limit: 1 })).toBe(1);
      pruned.resolve();
      await mayCommit.promise;
    });
    void pruning.catch(pruned.reject);
    try {
      await pruned.promise;
      await captureWithSqlTimeout();
      const fresh = await claimWithSqlTimeout(marked.id);
      if (!fresh) throw new Error("Expected overlapping claim");
      await captureWithSqlTimeout();
      const pending = await getDb(ctx.db)
        .select()
        .from(jobInvalidationCapture)
        .where(
          sql`${jobInvalidationCapture.key} = ${RESTARTING.key} AND NOT ${jobInvalidationCapture.observed}`,
        );
      expect(pending).toHaveLength(1);
      mayCommit.resolve();
      await pruning;
      expect(
        await getDb(ctx.db)
          .select()
          .from(jobInvalidationCapture)
          .where(
            sql`${jobInvalidationCapture.key} = ${RESTARTING.key} AND NOT ${jobInvalidationCapture.observed}`,
          ),
      ).toEqual(pending);
      expect(await captureCount(RESTARTING.key)).toBe(3);
      expect(await publishJobPage(ctx.db, fresh, { done: true })).toBe(false);
      const next = await claimJob(ctx.db, marked.id);
      expect(next?.generation).toBe(fresh.generation + 1);
    } finally {
      mayCommit.resolve();
      await pruning;
    }
  });

  it("unwinds a pruning overlap when a regressed claim tries to write observed input", async () => {
    const marked = await restarting();
    await capture(ctx.db);
    const initial = await claimJob(ctx.db, marked.id);
    if (!initial) throw new Error("Expected initial claim");
    await publishJobPage(ctx.db, initial, { done: true });
    const [observed] = await getDb(ctx.db)
      .select()
      .from(jobInvalidationCapture)
      .where(eq(jobInvalidationCapture.key, RESTARTING.key));
    if (!observed) throw new Error("Expected observed input");
    const pruned = Promise.withResolvers<void>();
    const mayCommit = Promise.withResolvers<void>();
    const pruning = withTransactionDatabase(ctx.db, async (tx) => {
      expect(await pruneObservedInvalidationCaptures(tx, { limit: 100 })).toBe(
        1,
      );
      pruned.resolve();
      await mayCommit.promise;
    });
    void pruning.catch(pruned.reject);
    try {
      await pruned.promise;
      await captureWithSqlTimeout();
      await expect(
        withTransactionDatabase(ctx.db, async (tx) => {
          await getDb(tx).execute(sql`SET LOCAL statement_timeout = '2s'`);
          const claimed = await claimJob(tx, marked.id);
          if (!claimed) throw new Error("Expected overlapping claim");
          // A negative control for the reviewed failure: writing an already
          // observed row waits behind pruning until the SQL deadline rejects.
          await getDb(tx)
            .update(jobInvalidationCapture)
            .set({ observed: true })
            .where(eq(jobInvalidationCapture.id, observed.id));
        }),
      ).rejects.toMatchObject({ cause: { code: "57014" } });
    } finally {
      mayCommit.resolve();
      await pruning;
    }
    expect(await row(marked.id)).toMatchObject({ state: "completed" });
    expect(await due(marked.id)).toBe(true);
    const pending = await getDb(ctx.db)
      .select()
      .from(jobInvalidationCapture)
      .where(
        sql`${jobInvalidationCapture.key} = ${RESTARTING.key} AND NOT ${jobInvalidationCapture.observed}`,
      );
    expect(pending).toHaveLength(1);
    expect(await claimJob(ctx.db, marked.id)).not.toBeNull();
  });

  it("keeps a rolled-back capture out and never loses a committed one", async () => {
    const marked = await restarting();
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await capture(tx);
        throw new Error("Synthetic rejected save");
      }),
    ).rejects.toThrow("Synthetic rejected save");
    expect(await captureCount(RESTARTING.key)).toBe(0);
    expect(await due(marked.id)).toBe(false);
    await withTransactionDatabase(ctx.db, (tx) => capture(tx));
    expect(await captureCount(RESTARTING.key)).toBe(1);
    // The completed execution row is untouched, yet the Job is due again.
    expect(await row(marked.id)).toMatchObject({
      state: "completed",
      generation: marked.generation,
    });
    expect(await due(marked.id)).toBe(true);
  });

  it("reruns a capture that landed while a page ran even after the worker died", async () => {
    const marked = await restarting();
    await capture(ctx.db);
    const first = await claimJob(ctx.db, marked.id);
    if (!first) throw new Error("Expected first claim");
    expect(first.generation).toBe(marked.generation + 1);
    await getDb(ctx.db)
      .update(job)
      .set({ cursor: { at: "synthetic-page" } })
      .where(eq(job.id, marked.id));
    await capture(ctx.db);
    // The worker vanishes; its lease expires and another claim takes over.
    await getDb(ctx.db)
      .update(job)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(job.id, marked.id));
    const reclaimed = await claimJob(ctx.db, marked.id);
    expect(reclaimed).toMatchObject({
      generation: first.generation + 1,
      cursor: null,
    });
    // A pass that finishes first (recipes) keeps its cursor across a capture
    // and a reclaim, completes, and its scheduled repeat reruns it.
    const quality = await family("recipes");
    await invalidateRefreshFamily(ctx.db, "recipes");
    const pass = await claimJob(ctx.db, quality.id);
    if (!pass) throw new Error("Expected recipes claim");
    await getDb(ctx.db)
      .update(job)
      .set({
        cursor: { at: "synthetic-quality-page" },
        leaseExpiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(job.id, quality.id));
    await invalidateRefreshFamily(ctx.db, "recipes");
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

  // Production finding: every household write restarted the search pass
  // (generation ~29k), so it never finished and new records went unindexed;
  // connection coverage then never confirmed. Families now finish a pass in
  // progress and rerun from the start for captures made meanwhile.
  it("finishes a search pass that captures keep landing on", async () => {
    const searchJob = await family("search");
    await invalidateRefreshFamily(ctx.db, "search");
    const first = await claimJob(ctx.db, searchJob.id);
    if (!first) throw new Error("Expected search claim");
    expect(
      await publishJobPage(ctx.db, first, {
        done: false,
        cursor: { at: "synthetic-search-page" },
      }),
    ).toBe(true);
    await invalidateRefreshFamily(ctx.db, "search");
    const next = await claimJob(ctx.db, searchJob.id);
    expect(next).toMatchObject({
      generation: first.generation,
      cursor: { at: "synthetic-search-page" },
    });
    await invalidateRefreshFamily(ctx.db, "search");
    expect(await publishJobPage(ctx.db, next!, { done: true })).toBe(true);
    expect((await row(searchJob.id)).state).toBe("completed");
    // The next capture reruns it from the start.
    await invalidateRefreshFamily(ctx.db, "search");
    expect(await due(searchJob.id)).toBe(true);
    const rerun = await claimJob(ctx.db, searchJob.id);
    expect(rerun).toMatchObject({
      generation: first.generation + 1,
      cursor: null,
    });
  });

  // A capture of a record the pass already scanned leaves the finished pass
  // due: the next full pass starts from the first record at once, so the
  // edit is revisited, never declared done.
  it("revisits a record captured behind the cursor in the next full pass", async () => {
    const searchJob = await family("search");
    await invalidateRefreshFamily(ctx.db, "search");
    const first = await claimJob(ctx.db, searchJob.id);
    if (!first) throw new Error("Expected search claim");
    await publishJobPage(ctx.db, first, {
      done: false,
      cursor: { at: "synthetic-later-page" },
    });
    // An edit to a record on the page already published.
    await invalidateRefreshFamily(ctx.db, "search");
    const last = await claimJob(ctx.db, searchJob.id);
    expect(last).toMatchObject({
      generation: first.generation,
      cursor: { at: "synthetic-later-page" },
    });
    expect(await publishJobPage(ctx.db, last!, { done: true })).toBe(true);
    expect(await row(searchJob.id)).toMatchObject({
      state: "completed",
      generation: first.generation,
    });
    expect(await due(searchJob.id)).toBe(true);
    expect(await claimJob(ctx.db, searchJob.id)).toMatchObject({
      generation: first.generation + 1,
      cursor: null,
    });
  });

  // Review finding: an unobserved capture made a non-restarting pass in
  // progress due at once, and its claim keeps the new pending input, so
  // the same capture bypassed every later backoff in a tight loop.
  it("keeps a failing pass in progress backing off through a capture", async () => {
    const searchJob = await family("search");
    await invalidateRefreshFamily(ctx.db, "search");
    const first = await claimJob(ctx.db, searchJob.id);
    if (!first) throw new Error("Expected search claim");
    await publishJobPage(ctx.db, first, {
      done: false,
      cursor: { at: "synthetic-later-page" },
    });
    await invalidateRefreshFamily(ctx.db, "search");
    const failing = await claimJob(ctx.db, searchJob.id);
    if (!failing) throw new Error("Expected search claim");
    await failJob(ctx.db, failing, new Error("Synthetic search failure"));
    expect(await row(searchJob.id)).toMatchObject({
      state: "retry_wait",
      cursor: { at: "synthetic-later-page" },
    });
    expect(await due(searchJob.id)).toBe(false);
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(eq(job.id, searchJob.id));
    expect(await claimJob(ctx.db, searchJob.id)).toMatchObject({
      generation: first.generation,
      cursor: { at: "synthetic-later-page" },
    });
  });

  // Review finding: an older Worker holding a family's final attempt across
  // the policy migration writes `failed` after it; nothing woke the family,
  // because its marker no longer restarts and repeats skip failed Jobs. The
  // database stores that write as a backoff instead.
  it("resumes a family an older build failed after the policy change", async () => {
    const searchJob = await family("search");
    await invalidateRefreshFamily(ctx.db, "search");
    const claim = await claimJob(ctx.db, searchJob.id);
    if (!claim) throw new Error("Expected search claim");
    await invalidateRefreshFamily(ctx.db, "search");
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "failed",
        cursor: { at: "synthetic-later-page" },
        leaseToken: null,
        leaseExpiresAt: null,
        error: "Job exhausted attempts after interrupted execution",
      })
      .where(eq(job.id, searchJob.id));
    expect(await row(searchJob.id)).toMatchObject({
      state: "retry_wait",
      cursor: { at: "synthetic-later-page" },
      error: "Job exhausted attempts after interrupted execution",
    });
    expect(await due(searchJob.id)).toBe(false);
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(Date.now() - 1_000) })
      .where(eq(job.id, searchJob.id));
    expect(await claimJob(ctx.db, searchJob.id)).toMatchObject({
      state: "running",
      cursor: { at: "synthetic-later-page" },
    });
  });

  it.each(["paused", "cancelled"] as const)(
    "keeps a %s family stopped across captures",
    async (stop) => {
      const searchJob = await family("search");
      await getDb(ctx.db)
        .update(job)
        .set({ state: stop })
        .where(eq(job.id, searchJob.id));
      await invalidateRefreshFamily(ctx.db, "search");
      expect(await due(searchJob.id)).toBe(false);
    },
  );

  // Families never stop on failure: a page that keeps failing backs off,
  // bounded by the maintenance policy, and a later claim resumes the pass.
  it("backs a failing family off instead of failing it", async () => {
    const searchJob = await family("search");
    await invalidateRefreshFamily(ctx.db, "search");
    for (let failure = 0; failure < 6; failure++) {
      await getDb(ctx.db)
        .update(job)
        .set({ availableAt: new Date(Date.now() - 1_000) })
        .where(eq(job.id, searchJob.id));
      const claim = await claimJob(ctx.db, searchJob.id);
      if (!claim) throw new Error("Expected search claim");
      await failJob(ctx.db, claim, new Error("Synthetic search failure"));
    }
    const failed = await row(searchJob.id);
    expect(failed.state).toBe("retry_wait");
    expect(failed.availableAt.getTime() - Date.now()).toBeLessThanOrEqual(
      15 * 60_000,
    );
  });

  it("never loses a capture that commits while publication runs", async () => {
    const marked = await restarting();
    await capture(ctx.db);
    const claim = await claimJob(ctx.db, marked.id);
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
    await capture(ctx.db);
    release();
    await publication;
    // Superseded or finished, the Job reruns for the capture.
    expect(await due(marked.id)).toBe(true);
  });

  it("commits a serializable capture while claim, renewal and publication run on another connection", async () => {
    const marked = await restarting();
    await capture(ctx.db);
    let attempts = 0;
    await withSnapshotWriteDatabase(
      ctx.db,
      async (tx) => {
        attempts++;
        await getDb(tx).select().from(job).where(eq(job.id, marked.id));
        await getDb(tx)
          .select()
          .from(jobInvalidation)
          .where(eq(jobInvalidation.key, RESTARTING.key));
        if (attempts === 1) {
          const claim = await claimJob(ctx.db, marked.id);
          if (!claim || !(await renewJob(ctx.db, claim)))
            throw new Error("Expected claim and renewal");
          if (
            !(await publishJobPage(ctx.db, claim, {
              done: false,
              cursor: { at: "synthetic-page" },
            }))
          )
            throw new Error("Expected publication");
          const next = await claimJob(ctx.db, marked.id);
          if (!next || !(await renewJob(ctx.db, next)))
            throw new Error("Expected second claim and renewal");
        }
        await capture(tx);
      },
      { isolationLevel: "serializable" },
    );
    expect(attempts).toBe(1);
    expect(await captureCount(RESTARTING.key)).toBe(2);
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
      const marked = await restarting();
      await capture(ctx.db);
      const claim = await claimJob(ctx.db, marked.id);
      if (!claim) throw new Error("Expected claim");
      const before = await captureCount(RESTARTING.key);
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
      const capturing = withSnapshotWriteDatabase(
        ctx.db,
        async (tx) => {
          captures++;
          await capture(tx);
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
        await capturing;
        releasePublication.open();
        await publication;
      } else {
        releasePublication.open();
        await publication;
        releaseCapture.open();
        await capturing;
      }
      expect(captures).toBe(1);
      expect(publications).toBeGreaterThanOrEqual(1);
      expect(await captureCount(RESTARTING.key)).toBe(before + 1);
      // The page either finished before observing the capture or was
      // superseded by it; either way the family reruns.
      expect(await due(marked.id)).toBe(true);
    },
  );

  // Review finding: a page that failed after a capture landed during its
  // pass was marked failed (or backed off) and the captured pass stranded.
  it.each(["exhausted", "retrying"] as const)(
    "starts a fresh pass when a page fails after a capture during its pass (%s)",
    async (budget) => {
      const marked = await restarting();
      await capture(ctx.db);
      const claim = await claimJob(ctx.db, marked.id);
      if (!claim) throw new Error("Expected claim");
      // The claim is on its last attempt when exhausted.
      const attempts = budget === "exhausted" ? claim.maxAttempts : 1;
      await getDb(ctx.db)
        .update(job)
        .set({ attempts, cursor: { at: "synthetic-page" } })
        .where(eq(job.id, marked.id));
      await capture(ctx.db);
      await failJob(
        ctx.db,
        { ...claim, attempts },
        new Error("Synthetic stale-input failure"),
      );
      expect(await row(marked.id)).toMatchObject({
        state: "queued",
        attempts: 0,
        cursor: null,
        error: expect.stringContaining("Synthetic stale-input failure"),
      });
      expect(await due(marked.id)).toBe(true);
      const fresh = await claimJob(ctx.db, marked.id);
      expect(fresh).toMatchObject({
        generation: claim.generation + 1,
      });
    },
  );

  it.each(["paused", "cancelled"] as const)(
    "keeps an explicit member stop (%s) when a capture lands during a failed pass",
    async (stop) => {
      const marked = await restarting();
      await capture(ctx.db);
      const claim = await claimJob(ctx.db, marked.id);
      if (!claim) throw new Error("Expected claim");
      await getDb(ctx.db)
        .update(job)
        .set({ state: stop })
        .where(eq(job.id, marked.id));
      await capture(ctx.db);
      await failJob(ctx.db, claim, new Error("Synthetic late failure"));
      expect((await row(marked.id)).state).toBe(stop);
      expect(await due(marked.id)).toBe(false);
    },
  );

  // Review finding: failJob and claimJob read the marker, then terminalized
  // the Job as failed in a later statement. A capture committing between the
  // two left a failed Job behind unobserved restarting input, and
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
    });
  };

  it("reruns a capture that commits while failJob terminalizes an exhausted pass", async () => {
    const marked = await restarting();
    await capture(ctx.db);
    const claim = await claimJob(ctx.db, marked.id);
    if (!claim) throw new Error("Expected claim");
    // The claim is on its last attempt, so this failure is terminal.
    await getDb(ctx.db)
      .update(job)
      .set({ attempts: claim.maxAttempts })
      .where(eq(job.id, marked.id));
    await latchTerminalWrite(
      () =>
        failJob(
          ctx.db,
          { ...claim, attempts: claim.maxAttempts },
          new Error("Synthetic final failure"),
        ),
      () => capture(ctx.db),
    );
    // The failure is recorded as it happened; the capture still reruns.
    expect((await row(marked.id)).state).toBe("failed");
    await expectFreshPass(marked.id, claim.generation);
  });

  it.each(["exhausted", "stalled"] as const)(
    "reruns a capture that commits while a claim terminalizes an %s Job",
    async (cause) => {
      const marked = await restarting();
      await capture(ctx.db);
      const claim = await claimJob(ctx.db, marked.id);
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
        .where(eq(job.id, marked.id));
      let terminal: Awaited<ReturnType<typeof claimJob>> | undefined;
      await latchTerminalWrite(
        async () => {
          terminal = await claimJob(ctx.db, marked.id);
        },
        () => capture(ctx.db),
      );
      expect(terminal).toBeNull();
      expect((await row(marked.id)).state).toBe("failed");
      // The fresh pass gets a fresh budget and recovery window, so it does
      // not fail again at once.
      await expectFreshPass(marked.id, claim.generation);
    },
  );
});
