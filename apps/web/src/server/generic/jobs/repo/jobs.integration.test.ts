import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  getDb,
  runBeforeCommitDatabase,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { job } from "~/server/db/schema";

import { withJobExecution } from "../context";
import { drainDueJobs } from "../service/jobs";
import { assertCurrentJob } from "./execution";
import {
  cancelJob,
  claimJob,
  enqueueJob,
  failJob,
  pauseJob,
  publishJobPage,
  retryJob,
} from "./jobs";

// A database intent survives lost queue wakes; leases and generations prevent
// interrupted or superseded workers from acknowledging somebody else's work.
describe("durable jobs", () => {
  const ctx = withTestDb();
  const enqueue = (key: string) =>
    enqueueJob(ctx.db, {
      key,
      kind: "refresh.search",
      input: {},
      invalidate: true,
    });

  // Publication installs an outer commit fence. Completing its own Job must
  // happen after that fence, while output and acknowledgement remain atomic.
  it("commits fenced output and its completed Job under a real execution context", async () => {
    const saved = await enqueue("synthetic.fenced-publication");
    const claimed = await claimJob(ctx.db, saved.id);
    if (!claimed) throw new Error("Expected publication claim");
    expect(
      await withJobExecution(ctx.db, claimed, () =>
        publishJobPage(ctx.db, claimed, { done: true }, async (tx) => {
          await assertCurrentJob(tx);
          await enqueueJob(tx, {
            key: "synthetic.fenced-output",
            kind: "synthetic.output",
            input: {},
          });
        }),
      ),
    ).toBe(true);
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.id, saved.id)))[0]
        ?.state,
    ).toBe("completed");
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.key, "synthetic.fenced-output"))
      )[0]?.state,
    ).toBe("queued");
  });

  // A transaction may outlive the lease even when PostgreSQL's transaction time has not changed.
  it("rolls back output when the Job expires before the transaction commits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const saved = await enqueue("synthetic.expired-before-commit");
      const claimed = await claimJob(ctx.db, saved.id);
      if (!claimed) throw new Error("Expected publication claim");
      await expect(
        withJobExecution(ctx.db, claimed, () =>
          withTransactionDatabase(ctx.db, async (tx) => {
            await assertCurrentJob(tx);
            await enqueueJob(tx, {
              key: "synthetic.expired-output",
              kind: "synthetic.output",
              input: {},
            });
            await runBeforeCommitDatabase(
              tx,
              async () => {
                vi.setSystemTime(claimed.leaseExpiresAt.getTime() + 1);
              },
              "capture",
            );
          }),
        ),
      ).rejects.toThrow("Job generation or lease is obsolete");
      expect(
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.key, "synthetic.expired-output")),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Cancellation/pause must fence an already prepared page. Explicit retry
  // resumes the committed checkpoint; a new input generation starts over.
  it("fences cancelled and paused workers and retains committed checkpoints on retry", async () => {
    const saved = await enqueue("synthetic.control");
    const first = await claimJob(ctx.db, saved.id);
    if (!first) throw new Error("Expected job claim");
    await publishJobPage(ctx.db, first, {
      done: false,
      cursor: { after: "synthetic-page" },
    });
    const second = await claimJob(ctx.db, saved.id);
    if (!second) throw new Error("Expected resumed claim");
    await pauseJob(ctx.db, saved.id);
    let published = false;
    expect(
      await publishJobPage(ctx.db, second, { done: true }, async () => {
        published = true;
      }),
    ).toBe(false);
    expect(published).toBe(false);
    expect((await retryJob(ctx.db, saved.id))?.cursor).toEqual({
      after: "synthetic-page",
    });
    const third = await claimJob(ctx.db, saved.id);
    if (!third) throw new Error("Expected retry claim");
    await cancelJob(ctx.db, saved.id);
    expect(await publishJobPage(ctx.db, third, { done: true })).toBe(false);
    expect(await claimJob(ctx.db, saved.id)).toBeNull();
  });

  // A lost follow-up queue wake must not reduce a family to one page per cron.
  it("drains consecutive pages fairly without reviving stopped work", async () => {
    const paged = await enqueueJob(ctx.db, {
      key: "synthetic.pages",
      kind: "synthetic.page",
      input: {},
    });
    const sibling = await enqueueJob(ctx.db, {
      key: "synthetic.sibling",
      kind: "synthetic.page",
      input: {},
    });
    const paused = await enqueueJob(ctx.db, {
      key: "synthetic.paused",
      kind: "synthetic.page",
      input: {},
    });
    await pauseJob(ctx.db, paused.id);
    const visited: string[] = [];
    await drainDueJobs(
      ctx.db,
      {
        "synthetic.page": {
          prepare: async (_db, claim) => {
            visited.push(claim.id);
            const cursor = typeof claim.cursor === "number" ? claim.cursor : 0;
            return { page: { done: cursor === 3, cursor: cursor + 1 } };
          },
        },
      },
      8,
    );
    expect(visited).toHaveLength(8);
    expect(visited.slice(0, 2)).toContain(sibling.id);
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.id, paged.id)))[0]
        ?.state,
    ).toBe("completed");
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.id, paused.id)))[0]
        ?.state,
    ).toBe("paused");
  });

  it("does not revive paused or exhausted work when a new broad capture arrives", async () => {
    const saved = await enqueue("synthetic.stopped-capture");
    await pauseJob(ctx.db, saved.id);
    expect((await enqueue("synthetic.stopped-capture")).state).toBe("paused");
  });

  it("rolls output and checkpoint back together when publication rejects", async () => {
    const saved = await enqueue("synthetic.publish-rollback");
    const claimed = await claimJob(ctx.db, saved.id);
    if (!claimed) throw new Error("Expected job claim");
    await expect(
      publishJobPage(ctx.db, claimed, { done: true }, async (tx) => {
        await enqueueJob(tx, {
          key: "synthetic.output-intent",
          kind: "refresh.search",
          input: {},
        });
        throw new Error("Synthetic publication rejected");
      }),
    ).rejects.toThrow("Synthetic publication rejected");
    expect(
      await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "synthetic.output-intent")),
    ).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.id, saved.id)))[0]
        ?.state,
    ).toBe("running");
  });

  it("rolls pending intent back with its authoritative transaction", async () => {
    await expect(
      withTransactionDatabase(ctx.db, async (tx) => {
        await enqueueJob(tx, {
          key: "synthetic.rollback",
          kind: "refresh.search",
          input: {},
        });
        throw new Error("Synthetic rejected save");
      }),
    ).rejects.toThrow("Synthetic rejected save");
    expect(
      await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, "synthetic.rollback")),
    ).toEqual([]);
  });

  it("claims committed work without a queue notification and refuses an expired owner", async () => {
    const saved = await enqueue("synthetic.recovery");
    const first = await claimJob(ctx.db, saved.id);
    expect(first).not.toBeNull();
    expect(await claimJob(ctx.db, saved.id)).toBeNull();
    await getDb(ctx.db)
      .update(job)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(job.id, saved.id));
    const next = await claimJob(ctx.db, saved.id);
    expect(next).not.toBeNull();
    if (!first || !next) throw new Error("Expected recoverable job claims");
    expect(await publishJobPage(ctx.db, first, { done: true })).toBe(false);
    expect(await publishJobPage(ctx.db, next, { done: true })).toBe(true);
  });

  it("cannot publish old outputs or erase an edit captured during a page", async () => {
    const saved = await enqueue("synthetic.generation");
    const first = await claimJob(ctx.db, saved.id);
    if (!first) throw new Error("Expected job claim");
    await enqueue("synthetic.generation");
    let published = false;
    expect(
      await publishJobPage(ctx.db, first, { done: true }, async () => {
        published = true;
      }),
    ).toBe(false);
    expect(published).toBe(false);
    const next = await claimJob(ctx.db, saved.id);
    expect(next?.generation).toBeGreaterThan(first.generation);
    expect(next?.cursor).toBeNull();
  });

  it("retains terminal failures without sweep-driven retries or duplicate jobs", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.failed",
      kind: "refresh.search",
      input: {},
      maxAttempts: 1,
    });
    const claimed = await claimJob(ctx.db, saved.id);
    if (!claimed) throw new Error("Expected job claim");
    await failJob(
      ctx.db,
      claimed,
      new Error("Synthetic upstream SQLSTATE 08006"),
    );
    expect(await claimJob(ctx.db, saved.id)).toBeNull();
    const duplicate = await enqueueJob(ctx.db, {
      key: "synthetic.failed",
      kind: "refresh.search",
      input: {},
      maxAttempts: 1,
    });
    expect(duplicate.id).toBe(saved.id);
    expect(duplicate.state).toBe("failed");
    expect(duplicate.error).toContain("SQLSTATE 08006");
  });
});
