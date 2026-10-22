import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { claimAiEvaluation } from "~/server/ai/repo/ai-evaluation";
import { enqueueAiEvaluation } from "~/server/ai/repo/ai-evaluation-requests";
import {
  getDb,
  runBeforeCommitDatabase,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { aiEvaluation, job } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import { setJobStepKey, withJobExecution } from "../context";
import { JobDeferredError } from "../errors";
import { advanceJob, drainDueJobs } from "../service/jobs";
import { assertCurrentJob } from "./execution";
import {
  cancelJob,
  claimJob,
  enqueueJob,
  dueJobs,
  dueJobsAhead,
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

  const evaluationClaim = async (result: { synthetic: string } | null) => {
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic claim target" }),
      ctx.actor,
    );
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const evaluation = await enqueueAiEvaluation(ctx.db, {
      runId,
      executionKind: "suggestion_sweep",
      shareKey: null,
      feature: "field-suggestion",
      target: {
        kind: "field",
        entity: "product",
        recordId: item.entityId,
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
      state: result ? "result_ready" : "queued",
      result,
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, `ai-evaluation:${evaluation.id}`));
    if (!saved) throw new Error("Expected evaluation Job");
    const claimed = await claimJob(ctx.db, saved.id);
    if (!claimed) throw new Error("Expected evaluation Job claim");
    return { evaluation, claimed };
  };

  it.each(["cancelled", "obsolete"] as const)(
    "does not revive an AI evaluation made %s while its claim waits",
    async (state) => {
      const result =
        state === "cancelled" ? null : { synthetic: "paid model result" };
      const { evaluation, claimed } = await evaluationClaim(result);
      let pending: ReturnType<typeof claimAiEvaluation> | undefined;
      try {
        await withTransactionDatabase(ctx.db, async (holder) => {
          await getDb(holder)
            .select()
            .from(aiEvaluation)
            .where(eq(aiEvaluation.id, evaluation.id))
            .for("update");
          const pid = await getDb(holder).execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );
          const holderPid = pid.rows[0]?.pid;
          if (!holderPid) throw new Error("Expected evaluation lock holder");
          pending = withJobExecution(ctx.db, claimed, () =>
            claimAiEvaluation(ctx.db, evaluation.id),
          );
          pending.catch(() => undefined);
          await expect
            .poll(async () => {
              const waiting = await getDb(ctx.db).execute<{
                waiting: boolean;
              }>(sql`SELECT EXISTS (
                SELECT 1 FROM pg_stat_activity
                WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
                  AND query ILIKE '%AiEvaluation%'
              ) AS waiting`);
              return waiting.rows[0]?.waiting;
            })
            .toBe(true);
          // The waiting claim must retain Job ownership until its transaction ends.
          await expect(
            withTransactionDatabase(ctx.db, async (probe) => {
              await getDb(probe)
                .select()
                .from(job)
                .where(eq(job.id, claimed.id))
                .for("update", { noWait: true });
            }),
          ).rejects.toMatchObject({ cause: { code: "55P03" } });
          await getDb(holder)
            .update(aiEvaluation)
            .set({ state })
            .where(eq(aiEvaluation.id, evaluation.id));
        });
        expect(await pending).toBeNull();
        expect(
          (
            await getDb(ctx.db)
              .select()
              .from(aiEvaluation)
              .where(eq(aiEvaluation.id, evaluation.id))
          )[0],
        ).toMatchObject({ state, result });
      } finally {
        await Promise.allSettled(pending ? [pending] : []);
      }
    },
  );

  it("reuses a paid AI result under its current Job claim", async () => {
    const result = { synthetic: "paid model result" };
    const { evaluation, claimed } = await evaluationClaim(result);
    expect(
      await withJobExecution(ctx.db, claimed, () =>
        claimAiEvaluation(ctx.db, evaluation.id),
      ),
    ).toMatchObject({
      state: "result_ready",
      result,
      attemptToken: claimed.leaseToken,
    });
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

  it("interleaves kinds and carries least-served fairness across exhausted drain budgets", async () => {
    const first = await enqueueJob(ctx.db, {
      key: "synthetic.image.high",
      kind: "a.image",
      input: {},
      priority: 100,
    });
    const second = await enqueueJob(ctx.db, {
      key: "synthetic.image.low",
      kind: "a.image",
      input: {},
      priority: 10,
    });
    const sweep = await enqueueJob(ctx.db, {
      key: "synthetic.sweep",
      kind: "b.sweep",
      input: {},
      priority: 0,
    });
    expect((await dueJobs(ctx.db, 3)).map((row) => row.id)).toEqual([
      first.id,
      sweep.id,
      second.id,
    ]);
    expect(await dueJobsAhead(ctx.db, second.id)).toBe(1);
    const visited: string[] = [];
    const handler = {
      prepare: async (_db: unknown, claim: { id: string }) => {
        visited.push(claim.id);
        return { page: { done: false } };
      },
    };
    const handlers = { "a.image": handler, "b.sweep": handler };
    await drainDueJobs(ctx.db, handlers, 1);
    await drainDueJobs(ctx.db, handlers, 1);
    expect(visited).toEqual([first.id, sweep.id]);
  });

  it("raises priority when a member resumes an automatically admitted Run", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "scheduled",
    });
    await launchWorkflowRun(ctx.db, {
      runId,
      purpose: "maintenance",
      automatic: true,
    });
    await launchWorkflowRun(ctx.db, { runId, purpose: "maintenance" });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.runId, runId));
    expect(saved).toMatchObject({ kind: "run.execute", priority: 100 });
  });

  it("persists a typed deferral without spending failures and clears waits on claim, publication and failure", async () => {
    const emitted = vi.spyOn(console, "info");
    const saved = await enqueue("synthetic.deferral");
    const until = new Date(Date.now() + 60_000);
    const read = async () =>
      (await getDb(ctx.db).select().from(job).where(eq(job.id, saved.id)))[0]!;
    expect(
      await advanceJob(ctx.db, saved.id, {
        [saved.kind]: {
          prepare: async () => {
            setJobStepKey("synthetic-step");
            throw new JobDeferredError(
              "Synthetic provider busy",
              until,
              "provider_capacity",
            );
          },
        },
      }),
    ).toBe("deferred");
    expect(await read()).toMatchObject({
      state: "queued",
      attempts: 0,
      waitReason: "provider_capacity",
      waitUntil: until,
      availableAt: until,
    });
    expect(emitted).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "[jobs] defer",
        jobId: saved.id,
        runId: null,
        kind: saved.kind,
        stepKey: "synthetic-step",
        generation: 1,
        attempt: 1,
        waitReason: "provider_capacity",
      }),
    );
    emitted.mockRestore();
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, saved.id));
    const claimed = await claimJob(ctx.db, saved.id);
    expect(claimed).toMatchObject({
      waitReason: null,
      waitUntil: null,
      attempts: 1,
    });
    if (!claimed) throw new Error("Expected resumed claim");
    await failJob(ctx.db, claimed, new Error("Synthetic provider failure"));
    expect(await read()).toMatchObject({
      state: "retry_wait",
      attempts: 1,
      waitReason: null,
      waitUntil: null,
      error: expect.stringContaining("Synthetic provider failure"),
    });
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, saved.id));
    const retry = await claimJob(ctx.db, saved.id);
    if (!retry) throw new Error("Expected retry claim");
    await publishJobPage(ctx.db, retry, { done: true });
    expect(await read()).toMatchObject({
      state: "completed",
      attempts: 0,
      waitReason: null,
      waitUntil: null,
      error: null,
    });
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
