import { pollUntil } from "@cubby/shared/retry";
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
import { aiEvaluation, job, entityIdentity } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  claimJob,
  failJob,
  publishJobPage,
  renewJob,
} from "~/server/generic/jobs/repo/external-claim";
import {
  cancelJob,
  pauseJob,
  retryJob,
} from "~/server/generic/jobs/repo/operator";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import {
  dueJobs,
  dueJobsAhead,
  lockJobProgress,
  recordJobInvalidation,
} from "~/server/generic/jobs/repo/queue";
import {
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import {
  launchWorkflowRun,
  MANUAL_RUN_PRIORITY,
} from "~/server/workflows/runs/lifecycle";

import { setJobStepKey, withJobExecution } from "../context";
import { JobDeferredError, JobSupersededError } from "../errors";
import { advanceJob, drainDueJobs } from "../service/jobs";
import { assertCurrentJob } from "./execution";

// A database intent survives lost queue wakes; leases and generations prevent
// interrupted or superseded workers from acknowledging somebody else's work.
describe("durable jobs", () => {
  const ctx = withTestDb();
  it("mints one long public identity for an idempotent enqueue and preserves it on invalidation", async () => {
    const input = {
      key: "synthetic:job-identity",
      kind: "synthetic.identity",
      input: {},
    };
    const first = await enqueueJob(ctx.db, input);
    const again = await enqueueJob(ctx.db, input);
    const invalidated = await enqueueJob(ctx.db, {
      ...input,
      invalidate: true,
    });
    expect(first.shortcode).toMatch(
      /^JOB-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/,
    );
    expect([again.id, invalidated.id]).toEqual([first.id, first.id]);
    expect([again.shortcode, invalidated.shortcode]).toEqual([
      first.shortcode,
      first.shortcode,
    ]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityIdentity)
        .where(eq(entityIdentity.id, first.id)),
    ).toMatchObject([{ kind: "job", shortcode: first.shortcode }]);
  });

  it.each([false, true])(
    "invalidates the stored identity after concurrent retention (replacement=%s)",
    async (replace) => {
      const input = {
        key: "synthetic:retention-invalidation",
        kind: "synthetic.race",
        input: {},
      };
      const old = await enqueueJob(ctx.db, input);
      await getDb(ctx.db)
        .update(job)
        .set({ state: "completed" })
        .where(eq(job.id, old.id));
      const locked = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const pruning = withTransactionDatabase(ctx.db, async (tx) => {
        await getDb(tx)
          .select()
          .from(job)
          .where(eq(job.id, old.id))
          .for("update");
        const backend = await getDb(tx).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        locked.resolve(backend.rows[0]!.pid);
        await release.promise;
        await getDb(tx).delete(job).where(eq(job.id, old.id));
        await getDb(tx)
          .delete(entityIdentity)
          .where(eq(entityIdentity.id, old.id));
        if (replace) await enqueueJob(tx, input);
      });
      const pid = await locked.promise;
      const invalidating = enqueueJob(ctx.db, { ...input, invalidate: true });
      try {
        await pollUntil(
          async () => {
            const blocked = await getDb(ctx.db).execute<{ blocked: boolean }>(
              sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`,
            );
            return blocked.rows[0]?.blocked ? true : undefined;
          },
          {
            label: "invalidation blocked by retention",
            timeoutMs: 5000,
            intervalMs: 10,
          },
        );
      } finally {
        release.resolve();
      }
      await pruning;
      const returned = await invalidating;
      const [stored] = await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, input.key));
      expect(returned.id).not.toBe(old.id);
      expect(returned).toMatchObject({
        id: stored!.id,
        shortcode: stored!.shortcode,
        state: "queued",
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(entityIdentity)
          .where(eq(entityIdentity.id, returned.id)),
      ).toMatchObject([{ shortcode: stored!.shortcode }]);
    },
  );
  it("opens serializable isolation before a snapshot-dependent Job publication", async () => {
    const work = await enqueueJob(ctx.db, {
      key: "synthetic-snapshot-publication",
      kind: "synthetic.snapshot",
      input: {},
    });
    expect(
      await advanceJob(ctx.db, work.id, {
        "synthetic.snapshot": {
          prepare: async () => ({
            isolationLevel: "serializable",
            page: { done: true },
            publish: async (tx) => {
              const result = await getDb(tx).execute<{ isolation: string }>(
                sql`SELECT current_setting('transaction_isolation') AS isolation`,
              );
              return { isolation: result.rows[0]?.isolation ?? "missing" };
            },
          }),
        },
      }),
    ).toBe("succeeded");
    const [saved] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, work.id));
    expect(saved?.result).toEqual({ isolation: "serializable" });
  });
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

  it("admits independent effect transactions under the same Job claim concurrently", async () => {
    const saved = await enqueue("synthetic.concurrent-effects");
    const claimed = await claimJob(ctx.db, saved.id);
    if (!claimed) throw new Error("Expected concurrent effect claim");
    await withJobExecution(ctx.db, claimed, () =>
      withTransactionDatabase(ctx.db, async (first) => {
        await assertCurrentJob(first);
        const firstPid = await getDb(first).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        await withTransactionDatabase(ctx.db, async (second) => {
          await getDb(second).execute(sql`SET LOCAL lock_timeout = '1s'`);
          const secondPid = await getDb(second).execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );
          expect(secondPid.rows[0]?.pid).not.toBe(firstPid.rows[0]?.pid);
          await assertCurrentJob(second);
          await enqueueJob(second, {
            key: "synthetic.concurrent-effect-second",
            kind: "synthetic.output",
            input: {},
          });
        });
        await enqueueJob(first, {
          key: "synthetic.concurrent-effect-first",
          kind: "synthetic.output",
          input: {},
        });
      }),
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(job)
        .where(
          sql`${job.key} IN ('synthetic.concurrent-effect-first', 'synthetic.concurrent-effect-second')`,
        ),
    ).toHaveLength(2);
  });

  it.each(["renew", "cancel", "pause", "invalidate"] as const)(
    "allows %s to progress after bounded rolling effect arrivals drain",
    async (action) => {
      const saved = await enqueue(`synthetic.shared-control-${action}`);
      const claimed = await claimJob(ctx.db, saved.id);
      if (!claimed) throw new Error("Expected shared-control claim");
      const holders: { release: () => void; completion: Promise<void> }[] = [];
      const holdEffect = () => {
        const admitted = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const completion = withJobExecution(ctx.db, claimed, () =>
          withTransactionDatabase(ctx.db, async (tx) => {
            await getDb(tx).execute(sql`SET LOCAL lock_timeout = '5s'`);
            await assertCurrentJob(tx);
            admitted.resolve();
            await release.promise;
          }),
        );
        completion.catch(admitted.reject);
        const holder = { release: () => release.resolve(), completion };
        holders.push(holder);
        return { ...holder, admitted: admitted.promise };
      };
      const controlStarted = Promise.withResolvers<number>();
      let control: Promise<void> | undefined;
      try {
        const first = holdEffect();
        const second = holdEffect();
        await Promise.all([first.admitted, second.admitted]);
        control = withTransactionDatabase(ctx.db, async (tx) => {
          const pid = await getDb(tx).execute<{ pid: number }>(
            sql`SELECT pg_backend_pid() AS pid`,
          );
          const controlPid = pid.rows[0]?.pid;
          if (!controlPid) throw new Error("Expected control connection");
          controlStarted.resolve(controlPid);
          switch (action) {
            case "renew":
              await renewJob(tx, claimed);
              break;
            case "cancel":
              await cancelJob(tx, claimed.id);
              break;
            case "pause":
              await pauseJob(tx, claimed.id);
              break;
            case "invalidate":
              await enqueueJob(tx, {
                key: saved.key,
                kind: saved.kind,
                input: {},
                invalidate: true,
              });
              break;
          }
        });
        control.catch(controlStarted.reject);
        const controlPid = await controlStarted.promise;
        const isWaiting = async () => {
          const waiting = await getDb(ctx.db).execute<{
            waiting: boolean;
          }>(sql`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE pid = ${controlPid}::int
              AND cardinality(pg_blocking_pids(pid)) > 0
          ) AS waiting`);
          return waiting.rows[0]?.waiting;
        };
        await expect.poll(isWaiting).toBe(true);
        let rolling = holdEffect();
        await rolling.admitted;
        // Fresh effects can pass a queued writer. Drain the original holders,
        // then roll a finite page frontier without assuming tuple-lock fairness.
        first.release();
        second.release();
        await Promise.all([first.completion, second.completion]);
        for (let index = 0; index < 8; index++) {
          const next = holdEffect();
          await next.admitted;
          rolling.release();
          await rolling.completion;
          rolling = next;
          await expect.poll(isWaiting).toBe(true);
        }
        rolling.release();
        await rolling.completion;
        await control;
        // A page must pass exclusive settlement before it can start more work.
        let nextPagePublished = false;
        const settled = await publishJobPage(
          ctx.db,
          claimed,
          { done: false },
          async () => {
            nextPagePublished = true;
          },
        );
        expect(settled).toBe(action === "renew");
        expect(nextPagePublished).toBe(action === "renew");
      } finally {
        for (const holder of holders) holder.release();
        await Promise.allSettled([
          ...holders.map((holder) => holder.completion),
          ...(control ? [control] : []),
        ]);
      }
    },
  );

  it("rejects an effect whose lease expires while it waits for ownership admission", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let pending: Promise<void> | undefined;
    try {
      const saved = await enqueue("synthetic.expired-admission");
      const claimed = await claimJob(ctx.db, saved.id);
      if (!claimed) throw new Error("Expected admission claim");
      await withTransactionDatabase(ctx.db, async (holder) => {
        await getDb(holder)
          .select()
          .from(job)
          .where(eq(job.id, claimed.id))
          .for("update");
        const pid = await getDb(holder).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        const holderPid = pid.rows[0]?.pid;
        if (!holderPid) throw new Error("Expected admission lock holder");
        pending = withJobExecution(ctx.db, claimed, () =>
          withTransactionDatabase(ctx.db, async (tx) => {
            await assertCurrentJob(tx);
            await enqueueJob(tx, {
              key: "synthetic.expired-admission-output",
              kind: "synthetic.output",
              input: {},
            });
          }),
        );
        pending.catch(() => undefined);
        await expect
          .poll(async () => {
            const waiting = await getDb(ctx.db).execute<{
              waiting: boolean;
            }>(sql`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
              AND query ILIKE '%Job%'
          ) AS waiting`);
            return waiting.rows[0]?.waiting;
          })
          .toBe(true);
        vi.setSystemTime(claimed.leaseExpiresAt.getTime() + 1);
      });
      await expect(pending).rejects.toBeInstanceOf(JobSupersededError);
      expect(
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.key, "synthetic.expired-admission-output")),
      ).toEqual([]);
    } finally {
      await Promise.allSettled(pending ? [pending] : []);
      vi.useRealTimers();
    }
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
          let competingCallback = false;
          await expect(
            withTransactionDatabase(ctx.db, async (second) => {
              await getDb(second).execute(sql`SET LOCAL lock_timeout = '1s'`);
              await publishJobPage(
                second,
                claimed,
                { done: true },
                async () => {
                  competingCallback = true;
                },
              );
            }),
          ).rejects.toMatchObject({ cause: { code: "55P03" } });
          expect(competingCallback).toBe(false);
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
  it.each(["direct", "savepoint"] as const)(
    "rolls back output when the Job expires before the %s transaction commits",
    async (boundary) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const saved = await enqueue("synthetic.expired-before-commit");
        const claimed = await claimJob(ctx.db, saved.id);
        if (!claimed) throw new Error("Expected publication claim");
        await expect(
          withJobExecution(ctx.db, claimed, () =>
            withTransactionDatabase(ctx.db, async (tx) => {
              if (boundary === "savepoint")
                await withTransactionDatabase(tx, (child) =>
                  assertCurrentJob(child),
                );
              else await assertCurrentJob(tx);
              await enqueueJob(tx, {
                key: "synthetic.expired-output",
                kind: "synthetic.output",
                input: {},
              });
              await runBeforeCommitDatabase(
                tx,
                async () => {
                  vi.setSystemTime(claimed.leaseExpiresAt.getTime() + 1);
                  expect(await claimJob(ctx.db, claimed.id)).toBeNull();
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
    },
  );

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
    // List positions count earlier due siblings; drain turns still interleave kinds.
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
    // An invalidation between wakes is new intent, not service: the image
    // kind was still claimed least recently.
    await enqueueJob(ctx.db, {
      key: "synthetic.image.low",
      kind: "a.image",
      input: { revision: 2 },
      priority: 10,
      invalidate: true,
    });
    await drainDueJobs(ctx.db, handlers, 1);
    expect(visited).toEqual([first.id, sweep.id, first.id]);
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
    expect(saved).toMatchObject({
      kind: "run.execute",
      priority: MANUAL_RUN_PRIORITY,
    });
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

  it.each([false, true])(
    "selects timed and captured work once while respecting restart policy (%s)",
    async (restartsPass) => {
      const input = {
        key: "synthetic.selector-capture",
        kind: "synthetic.capture",
        input: {},
      };
      const saved = await enqueueJob(ctx.db, input);
      // Multiple pending captures must not duplicate a Job that is also timed due.
      await recordJobInvalidation(ctx.db, { ...input, restartsPass });
      await recordJobInvalidation(ctx.db, { ...input, restartsPass });
      const selected = async () =>
        (await dueJobs(ctx.db)).filter((row) => row.id === saved.id);
      expect(await selected()).toHaveLength(1);
      for (const { state, expected } of [
        { state: "retry_wait", expected: restartsPass ? 1 : 0 },
        { state: "completed", expected: 1 },
        { state: "failed", expected: restartsPass ? 1 : 0 },
        { state: "paused", expected: 0 },
        { state: "cancelled", expected: 0 },
      ] as const) {
        // Seed historical terminal states without consuming their pending captures.
        await getDb(ctx.db)
          .update(job)
          .set({ state, availableAt: new Date(Date.now() + 60_000) })
          .where(eq(job.id, saved.id));
        expect(await selected()).toHaveLength(expected);
      }
    },
  );

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

  it("recovers interrupted progress-budget Jobs beyond the attempt ceiling but stops idle waits", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.progress-recovery",
      kind: "refresh.search",
      input: {},
      maxAttempts: 1,
      recoveryTimeoutMs: 30 * 60_000,
    });
    let claim = await claimJob(ctx.db, saved.id);
    if (!claim) throw new Error("Expected initial claim");
    await failJob(ctx.db, claim, new Error("Synthetic interrupted page"));
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, saved.id));
    claim = await claimJob(ctx.db, saved.id);
    expect(claim?.attempts).toBe(2);
    if (!claim) throw new Error("Expected same-Job recovery");
    const recovery = claim;
    await withTransactionDatabase(ctx.db, async (tx) => {
      const progress = await lockJobProgress(tx, recovery);
      await progress();
    });
    const beforeWait = (
      await getDb(ctx.db).select().from(job).where(eq(job.id, saved.id))
    )[0]!;
    expect(
      await publishJobPage(ctx.db, claim, {
        done: false,
        waitUntil: new Date(Date.now() + 60 * 60_000),
        waitReason: "provider_capacity",
      }),
    ).toBe(true);
    const afterWait = (
      await getDb(ctx.db).select().from(job).where(eq(job.id, saved.id))
    )[0]!;
    expect(afterWait.lastUsefulProgressAt).toEqual(
      beforeWait.lastUsefulProgressAt,
    );
    await getDb(ctx.db)
      .update(job)
      .set({ lastUsefulProgressAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(job.id, saved.id));
    await dueJobs(ctx.db);
    const stopped = (
      await getDb(ctx.db).select().from(job).where(eq(job.id, saved.id))
    )[0]!;
    expect(stopped).toMatchObject({
      state: "failed",
      error: "Job stopped after its useful-progress recovery window expired",
    });
    expect(await claimJob(ctx.db, saved.id)).toBeNull();
    const retried = await retryJob(ctx.db, saved.id);
    expect(retried?.generation).toBe(stopped.generation + 1);
    expect(retried!.lastUsefulProgressAt!.getTime()).toBeGreaterThan(
      stopped.lastUsefulProgressAt!.getTime(),
    );
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
