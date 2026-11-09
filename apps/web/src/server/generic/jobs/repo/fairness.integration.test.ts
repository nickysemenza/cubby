import { eq, inArray, asc, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransaction } from "~/server/db/helpers";
import { job, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import {
  runPermit,
  type PermitRuntime,
} from "~/server/generic/jobs/service/permits";
import type { JobHandlers } from "~/server/generic/jobs/types";
import { reconcileWorkflowRuns } from "~/server/workflows/runs/lifecycle";

import { enqueueJob, enqueueJobs } from "./producer";
import { dueUnits } from "./queue";

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

    const selected = await dueUnits(ctx.db, [], 2);
    expect(
      selected.map((entry) => (entry.type === "job" ? entry.id : null)),
    ).toEqual([owned.id, ordinary.id]);
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

    const selected = await dueUnits(ctx.db, [], 10);
    for (const other of others) {
      const position = selected.findIndex(
        (entry) => entry.type === "job" && entry.id === other.id,
      );
      expect(position).toBeGreaterThanOrEqual(0);
      expect(position).toBeLessThan(4);
    }
  }, 60_000);

  it("runs one unit per permit: skips a locked Job, rotates drains with Jobs, and ends idle chains", async () => {
    const busy = await enqueueJob(ctx.db, {
      key: "synthetic.permit.busy",
      kind: "synthetic.a-busy",
      input: {},
    });
    const ran: string[] = [];
    const handlers: JobHandlers = {
      "synthetic.a-busy": {
        prepare: async () => {
          ran.push("synthetic.a-busy");
          return { page: { done: true } };
        },
      },
      "synthetic.b-progress": {
        prepare: async () => {
          ran.push("synthetic.b-progress");
          return { page: { done: true } };
        },
      },
    };
    let owed = 2;
    const drain: BackgroundDrain = {
      name: "synthetic.drain",
      due: () =>
        owed > 0
          ? sql`SELECT 'synthetic.drain'::text AS unit, false AS demand, now()::timestamp AS since`
          : null,
      next: () => (owed > 0 ? sql`SELECT now()::timestamp` : null),
      page: async () => {
        owed--;
        ran.push("synthetic.drain");
        return { claimed: 1 };
      },
    };
    const sent: (Date | null)[] = [];
    const runtime: PermitRuntime = {
      db: ctx.db,
      handlers,
      drains: [drain],
      ports: {
        send: async (at, source) => {
          if (source !== "job.lease-recovery") sent.push(at);
        },
        captureException: (error) => {
          throw error;
        },
      },
    };
    await enqueueJob(ctx.db, {
      key: "synthetic.permit.progress",
      kind: "synthetic.b-progress",
      input: {},
    });

    // A sibling holds the first candidate's row: the permit runs the next one.
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holding = withTransaction(ctx.db, async (tx) => {
      await tx.select().from(job).where(eq(job.id, busy.id)).for("update");
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      expect(await runPermit(runtime)).not.toBe("synthetic.a-busy");
      expect(ran).toHaveLength(1);
    } finally {
      release.resolve();
      await holding;
    }
    // Owed work remains, so the unit sent exactly one successor, due now.
    expect(sent).toEqual([null]);

    // Every never-served unit runs before any unit runs twice.
    for (let unit = await runPermit(runtime); unit;)
      unit = await runPermit(runtime);
    expect(new Set(ran.slice(0, 3))).toEqual(
      new Set(["synthetic.a-busy", "synthetic.b-progress", "synthetic.drain"]),
    );
    expect(ran.filter((unit) => unit === "synthetic.drain")).toHaveLength(2);

    // An over-produced permit exits after selection and sends nothing.
    const before = sent.length;
    expect(await runPermit(runtime)).toBeNull();
    expect(sent).toHaveLength(before);
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
