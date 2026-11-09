import { eq, inArray, asc } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb, withTransaction } from "~/server/db/helpers";
import { job, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  admittedDrain,
  type BackgroundDrain,
} from "~/server/generic/background/drains";
import { runBackgroundRound } from "~/server/generic/background/work-round";
import type { JobHandlers } from "~/server/generic/jobs/types";
import { drainProductionJobs } from "~/server/workflows/jobs";
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

  it("revisits refused work and shares preparation fairly without claiming held pages", async () => {
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
        .select({ state: job.state })
        .from(job)
        .where(eq(job.id, busy.id));
      expect(stored).toEqual({
        state: "completed",
      });
    } finally {
      release.resolve();
      await holding;
    }

    const queued = await enqueueJobs(
      ctx.db,
      [3, 2, 1].map((priority) => ({
        key: `synthetic.shared-page.${priority}`,
        kind: "synthetic.shared-page",
        input: {},
        priority,
      })),
    );
    const slow = queued.find((row) => row.priority === 3);
    if (!slow) throw new Error("Synthetic slow Job missing");
    const waitingIds = queued
      .filter((row) => row.id !== slow.id)
      .map((row) => row.id);
    const waitingBefore = await getDb(ctx.db)
      .select()
      .from(job)
      .where(inArray(job.id, waitingIds));
    const jobReady = Promise.withResolvers<void>();
    const featureReady = Promise.withResolvers<void>();
    const discoveryReady = Promise.withResolvers<void>();
    const releaseDiscovery = Promise.withResolvers<void>();
    const releaseJob = Promise.withResolvers<void>();
    const releaseFeature = Promise.withResolvers<void>();
    const payloadBytes = 12 * 1024 * 1024;
    let retainedBytes = 0;
    let peakBytes = 0;
    const withPayload = async <T>(work: (bytes: Uint8Array) => Promise<T>) => {
      const bytes = new Uint8Array(payloadBytes);
      bytes[0] = 7;
      retainedBytes += bytes.byteLength;
      peakBytes = Math.max(peakBytes, retainedBytes);
      try {
        return await work(bytes);
      } finally {
        retainedBytes -= bytes.byteLength;
      }
    };
    const handlers: JobHandlers = {
      "synthetic.shared-page": {
        prepare: async (_db, claim) => ({
          page: { done: true },
          publish: () =>
            withPayload(async (bytes) => {
              if (claim.id === slow.id) {
                jobReady.resolve();
              }
              await releaseJob.promise;
              expect(bytes[0]).toBe(7);
              return { retainedBytes: bytes.byteLength };
            }),
        }),
      },
    };
    const startedFeatures: string[] = [];
    let failLate = false;
    let expireDiscovery: (() => void) | undefined;
    const early = admittedDrain({
      name: "synthetic.early",
      page: async () =>
        withPayload(async () => {
          startedFeatures.push("early");
          featureReady.resolve();
          await releaseFeature.promise;
          return { more: false, nextAt: null, settled: 1 };
        }),
    });
    const drains: BackgroundDrain[] = [
      {
        name: early.name,
        page: async (db, round) => {
          discoveryReady.resolve();
          await releaseDiscovery.promise;
          expireDiscovery?.();
          return early.page(db, round);
        },
      },
      admittedDrain({
        name: "synthetic.late",
        page: async () =>
          withPayload(async () => {
            startedFeatures.push("late");
            if (failLate)
              throw new Error("Synthetic feature preparation failure");
            return { more: false, nextAt: null, settled: 1 };
          }),
      }),
    ];
    const startedAt = Date.now();
    const firstRound = runBackgroundRound(ctx.db, handlers, drains, {
      timeBudgetMs: 30_000,
    });
    try {
      await Promise.all([jobReady.promise, discoveryReady.promise]);
      // Discovery latency cannot let later features or a second Job steal its turn.
      expect(startedFeatures).toEqual([]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(inArray(job.id, waitingIds)),
      ).toEqual(waitingBefore);
      releaseDiscovery.resolve();
      await featureReady.promise;
      expect(retainedBytes).toBe(2 * payloadBytes);
      // A second invocation cannot claim work while the isolate's slots are held.
      const overlap = await runBackgroundRound(ctx.db, handlers, drains, {
        afterDrain: "synthetic.early",
      });
      expect(overlap.statistics.started).toBe(0);
      expect(overlap.more).toBe(false);
      expect(overlap.nextAt?.getTime()).toBeGreaterThan(Date.now() + 10_000);
      expect(
        await drainProductionJobs(ctx.db, { afterDrain: "derived-rebuild" }),
      ).toEqual([]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(inArray(job.id, waitingIds)),
      ).toEqual(waitingBefore);

      const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt + 60_000);
      let afterDrain: string | undefined;
      try {
        releaseFeature.resolve();
        expect(
          await getDb(ctx.db)
            .select()
            .from(job)
            .where(inArray(job.id, waitingIds)),
        ).toEqual(waitingBefore);
        releaseJob.resolve();
        const first = await firstRound;
        expect(first.failures).toEqual([]);
        expect(first.statistics.peakLocalPages).toBe(2);
        expect(first.afterDrain).toBe("synthetic.early");
        expect(startedFeatures).toEqual(["early"]);
        afterDrain = first.afterDrain;
      } finally {
        releaseJob.resolve();
        releaseFeature.resolve();
        await firstRound;
        clock.mockRestore();
      }
      failLate = true;
      const resumed = await runBackgroundRound(ctx.db, handlers, drains, {
        afterDrain,
      });
      expect(resumed.failures).toHaveLength(1);
      expect(startedFeatures.slice(1)).toEqual(["late", "early"]);
      const completed = await getDb(ctx.db)
        .select()
        .from(job)
        .where(
          inArray(
            job.id,
            queued.map((row) => row.id),
          ),
        );
      expect(completed).toHaveLength(3);
      expect(
        completed.every(
          (row) =>
            row.state === "completed" &&
            row.generation === 1 &&
            row.attempts === 0,
        ),
      ).toBe(true);
      failLate = false;
      await enqueueJob(ctx.db, {
        key: "synthetic.shared-page.after-failure",
        kind: "synthetic.shared-page",
        input: {},
      });
      const recovered = await runBackgroundRound(ctx.db, handlers, drains, {
        afterDrain: resumed.afterDrain,
      });
      expect(recovered.failures).toEqual([]);
      expect(recovered.outcomes).toEqual(["succeeded"]);
      expect(recovered.statistics.peakLocalPages).toBe(2);
      expect(peakBytes).toBeLessThanOrEqual(2 * payloadBytes);
      expect(retainedBytes).toBe(0);
      const expiredClock = vi.spyOn(Date, "now");
      let expiredAfter: string | undefined;
      try {
        expireDiscovery = () =>
          expiredClock.mockReturnValue(startedAt + 600_000);
        const expired = await runBackgroundRound(ctx.db, handlers, drains, {
          afterDrain: "synthetic.late",
        });
        expect(expired.afterDrain).toBe("synthetic.early");
        expect(expired.more).toBe(false);
        expect(expired.nextAt?.getTime()).toBeGreaterThan(Date.now());
        expiredAfter = expired.afterDrain;
      } finally {
        expireDiscovery = undefined;
        expiredClock.mockRestore();
      }
      const featureOffset = startedFeatures.length;
      await runBackgroundRound(ctx.db, handlers, drains, {
        afterDrain: expiredAfter,
      });
      expect(startedFeatures.slice(featureOffset)).toEqual(["late", "early"]);
    } finally {
      releaseJob.resolve();
      releaseFeature.resolve();
      releaseDiscovery.resolve();
      await firstRound;
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
