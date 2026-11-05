import { eq, inArray, asc } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransaction } from "~/server/db/helpers";
import { job, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { reconcileWorkflowRuns } from "~/server/workflows/runs/lifecycle";

import { drainDueJobs } from "../service/jobs";
import { enqueueJob, enqueueJobs } from "./producer";
import { dueJobs } from "./queue";

describe("durable Job selection", () => {
  const ctx = withTestDb();

  it("serves active Run-owned work before unowned work", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
      execution: false,
    });
    const ordinary = await enqueueJob(ctx.db, {
      key: "synthetic.fairness.ordinary",
      kind: "synthetic.ordinary",
      input: {},
      priority: 100,
    });
    const owned = await enqueueJob(ctx.db, {
      key: "synthetic.fairness.owned",
      kind: "synthetic.owned",
      input: {},
      runId,
    });

    const selected = await dueJobs(ctx.db, 2);
    expect(selected.map((entry) => entry.id)).toEqual([owned.id, ordinary.id]);
    expect(selected[0]?.runOwned).toBe(true);
  });

  it("round-robins kinds while one kind has a large Job backlog", async () => {
    const flood = Array.from({ length: 10_000 }, (_, index) => ({
      key: `synthetic.fairness.flood.${index}`,
      kind: "synthetic.flood",
      input: {},
    }));
    // One statement per slice: a 10k-row insert overflows drizzle's builder.
    for (let start = 0; start < flood.length; start += 1_000)
      await enqueueJobs(ctx.db, flood.slice(start, start + 1_000));
    const others = await enqueueJobs(
      ctx.db,
      [0, 1, 2].map((index) => ({
        key: `synthetic.fairness.other.${index}`,
        kind: `synthetic.other.${index}`,
        input: {},
      })),
    );

    const selected = await dueJobs(ctx.db, 10);
    for (const other of others) {
      const position = selected.findIndex((entry) => entry.id === other.id);
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThan(4);
    }
  }, 60_000);

  it("publishes a previously busy uncapped Job after another page makes progress", async () => {
    const busy = await enqueueJob(ctx.db, {
      key: "synthetic.reconsider.busy",
      kind: "synthetic.a-busy",
      input: {},
    });
    await enqueueJob(ctx.db, {
      key: "synthetic.reconsider.progress",
      kind: "synthetic.b-progress",
      input: {},
    });
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = withTransaction(ctx.db, async (tx) => {
      await tx.select().from(job).where(eq(job.id, busy.id)).for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      await drainDueJobs(
        ctx.db,
        {
          "synthetic.a-busy": {
            prepare: async () => ({
              page: { done: true },
              publish: async () => ({ outcome: "synthetic published result" }),
            }),
          },
          "synthetic.b-progress": {
            prepare: async () => {
              release.resolve();
              await holding;
              return { page: { done: true } };
            },
          },
        },
        3,
        30_000,
        1,
      );
      const [stored] = await getDb(ctx.db)
        .select({ state: job.state, result: job.result })
        .from(job)
        .where(eq(job.id, busy.id));
      expect(stored).toEqual({
        state: "completed",
        result: { outcome: "synthetic published result" },
      });
    } finally {
      release.resolve();
      await holding;
    }
  });

  it("walks past a locked reconciliation page and revisits skipped Runs on a later pass", async () => {
    const jobs = [];
    for (let index = 0; index < 101; index++) {
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "background",
        trigger: "manual",
        status: "running",
        execution: false,
      });
      jobs.push(
        await enqueueJob(ctx.db, {
          key: `synthetic.reconcile.${index}`,
          kind: "run.execute",
          runId,
          input: {},
        }),
      );
    }
    await getDb(ctx.db)
      .update(job)
      .set({ state: "failed", error: "Synthetic stopped execution" })
      .where(
        inArray(
          job.id,
          jobs.map((row) => row.id),
        ),
      );
    const ordered = await getDb(ctx.db)
      .select({ id: job.id, runId: job.runId })
      .from(job)
      .where(eq(job.kind, "run.execute"))
      .orderBy(asc(job.id));
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = withTransaction(ctx.db, async (tx) => {
      await tx
        .select()
        .from(run)
        .where(
          inArray(
            run.id,
            ordered.slice(0, 100).map((row) => row.runId!),
          ),
        )
        .for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      const first = await reconcileWorkflowRuns(ctx.db);
      expect(first.reconciled).toBe(0);
      expect(first.next).not.toBeNull();
      const second = await reconcileWorkflowRuns(ctx.db, first.next);
      expect(second).toEqual({ reconciled: 1, next: null });
    } finally {
      release.resolve();
      await holding;
    }
    expect((await reconcileWorkflowRuns(ctx.db)).reconciled).toBe(100);
  });
});
