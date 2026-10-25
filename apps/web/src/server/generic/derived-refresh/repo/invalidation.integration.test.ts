import { eq } from "drizzle-orm";
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
});
