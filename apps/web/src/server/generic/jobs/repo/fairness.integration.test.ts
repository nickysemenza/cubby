import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { JOB_DRAIN } from "../limits";
import { drainDueJobs } from "../service/jobs";
import type { JobHandlers } from "../types";
import {
  claimJob,
  dueJobs,
  enqueueJob,
  releaseJobClaim,
  type JobClaim,
} from "./jobs";
import { loadJobWaitingOn } from "./waiting-on";

/** Deterministic drain rounds: each selected Job is claimed, then finished. */
async function drainRounds(
  db: Parameters<typeof dueJobs>[0],
  rounds: number,
  onRound: (claimed: readonly { id: string; kind: string }[]) => void,
) {
  for (let round = 0; round < rounds; round++) {
    const batch = await dueJobs(db, JOB_DRAIN.batch);
    if (!batch.length) return;
    onRound(batch);
    const ids = batch.map((row) => row.id);
    // A synthetic, strictly increasing claim clock keeps service order
    // deterministic within one wall-clock millisecond.
    await getDb(db)
      .update(job)
      .set({
        state: "completed",
        lastClaimedAt: sql`now() + ${round} * interval '1 second'`,
      })
      .where(inArray(job.id, ids));
  }
}

// Production finding: one connection-discovery Run enqueued ~55k evaluations,
// and every other kind waited behind the per-kind round-robin.
describe("fair drain under a flood", () => {
  const ctx = withTestDb();

  it(
    "scans past locked expired evaluations for the rest of the invocation",
    { timeout: 30_000 },
    async () => {
      const expired: JobClaim["id"][] = [];
      for (let index = 0; index < 3; index++) {
        const row = await enqueueJob(ctx.db, {
          key: `synthetic.locked-expiry.${index}`,
          kind: "ai.evaluation",
          input: {},
          priority: 100,
        });
        await getDb(ctx.db)
          .update(job)
          .set({
            state: "running",
            leaseToken: crypto.randomUUID(),
            leaseExpiresAt: new Date(0),
          })
          .where(eq(job.id, row.id));
        expired.push(row.id);
      }
      const healthy = await enqueueJob(ctx.db, {
        key: "ai-evaluation:synthetic-unlocked-evaluation",
        kind: "ai.evaluation",
        input: {},
      });
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holding = withTransactionDatabase(ctx.db, async (tx) => {
        await getDb(tx)
          .select()
          .from(job)
          .where(inArray(job.id, expired))
          .for("update");
        locked.resolve();
        await release.promise;
      });
      holding.catch(locked.reject);
      const served: string[] = [];
      const handlers: JobHandlers = {
        "ai.evaluation": {
          prepare: async (_db, claim) => {
            served.push(claim.id);
            return { page: { done: true } };
          },
        },
      };
      try {
        await locked.promise;
        const outcomes = await drainDueJobs(ctx.db, handlers, 12);
        expect(served).toEqual([healthy.id]);
        expect(
          outcomes.filter((outcome) => outcome === "skipped"),
        ).toHaveLength(3);
      } finally {
        release.resolve();
        await holding;
      }
      await drainDueJobs(ctx.db, handlers, 12);
      expect(new Set(served)).toEqual(new Set([healthy.id, ...expired]));
    },
  );

  it.each([false, true])(
    "reserves an embedding execution lane ahead of three blocked Run pages (owned=%s)",
    { timeout: 60_000 },
    async (owned) => {
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        trigger: "manual",
        execution: false,
      });
      for (let index = 0; index < 3; index++)
        await enqueueJob(ctx.db, {
          key: `synthetic.reserved-run.${index}`,
          kind: "run.execute",
          input: {},
          runId,
        });
      await enqueueJob(ctx.db, {
        key: "synthetic.reserved-embedding",
        kind: "embedding.refresh",
        input: {},
        ...(owned ? { runId } : {}),
      });
      if (owned)
        await enqueueJob(ctx.db, {
          key: "synthetic.reserved-backfill",
          kind: "embedding.refresh",
          input: {},
        });
      const otherKinds = owned
        ? []
        : Array.from(
            { length: 30 },
            (_, index) => `a.synthetic-background.${index}`,
          );
      for (const kind of otherKinds)
        await enqueueJob(ctx.db, { key: kind, kind, input: {} });
      const release = Promise.withResolvers<void>();
      let runs = 0;
      let embeddings = 0;
      const handlers: JobHandlers = {
        ...Object.fromEntries(
          otherKinds.map((kind) => [
            kind,
            { prepare: async () => ({ page: { done: true } }) },
          ]),
        ),
        "run.execute": {
          prepare: async () => {
            runs++;
            await release.promise;
            return { page: { done: true } };
          },
        },
        "embedding.refresh": {
          prepare: async () => {
            throw new Error("Expected batch execution");
          },
          batch: {
            size: 100,
            execute: async (_db, claims, { checkpoint }) => {
              embeddings++;
              await release.promise;
              await checkpoint(
                new Map(
                  claims.map((claim) => [
                    claim.id,
                    { status: "fulfilled", value: { page: { done: true } } },
                  ]),
                ),
              );
            },
          },
        },
      };
      const draining = drainDueJobs(ctx.db, handlers, 32);
      try {
        await expect.poll(() => runs + embeddings, { timeout: 10_000 }).toBe(3);
        expect(embeddings).toBe(1);
        expect(runs).toBe(2);
      } finally {
        release.resolve();
        await draining;
      }
      expect(runs).toBe(3);
    },
  );

  it.each(["image.cloud", "synthetic.blocked"])(
    "keeps consumers available while %s pages are blocked",
    { timeout: 60_000 },
    async (kind) => {
      for (let index = 0; index < 12; index++)
        await enqueueJob(ctx.db, {
          key: `synthetic.consumer-flood.${index}`,
          kind,
          input: {},
        });
      const release = Promise.withResolvers<void>();
      let active = 0;
      let peak = 0;
      let settled = 0;
      let healthy = false;
      const handlers: JobHandlers = {
        [kind]: {
          prepare: async () => {
            active++;
            peak = Math.max(peak, active);
            await release.promise;
            active--;
            return { page: { done: true } };
          },
        },
        "synthetic.new-kind": {
          prepare: async () => {
            healthy = true;
            return { page: { done: true } };
          },
        },
      };
      const consumers = Array.from({ length: 4 }, () =>
        drainDueJobs(ctx.db, handlers, 32).finally(() => {
          settled++;
        }),
      );
      try {
        await expect.poll(() => active, { timeout: 10_000 }).toBeGreaterThan(0);
        await expect
          .poll(() => settled, { timeout: 10_000 })
          .toBeGreaterThan(0);
        expect(peak).toBeLessThanOrEqual(2);
        await enqueueJob(ctx.db, {
          key: "synthetic.consumer-new-work",
          kind: "synthetic.new-kind",
          input: {},
        });
        await drainDueJobs(ctx.db, handlers, 32);
        expect(healthy).toBe(true);
      } finally {
        release.resolve();
        await Promise.all(consumers);
      }
    },
  );

  it(
    "fills embedding pages to 100 Jobs while other kinds are due",
    { timeout: 120_000 },
    async () => {
      for (const [kind, count] of [
        ["embedding.refresh", 200],
        ["image.cloud", 20],
      ] as const)
        for (let index = 0; index < count; index++)
          await enqueueJob(ctx.db, {
            key: `synthetic.full-page.${kind}.${index}`,
            kind,
            input: {},
          });
      const pages: number[] = [];
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let active = 0;
      let peak = 0;
      let images = 0;
      const handlers: JobHandlers = {
        "embedding.refresh": {
          prepare: async () => {
            throw new Error("Expected batch execution");
          },
          batch: {
            size: 100,
            execute: async (_db, claims, { checkpoint }) => {
              pages.push(claims.length);
              active++;
              peak = Math.max(peak, active);
              if (pages.length === 1) {
                started.resolve();
                await release.promise;
              }
              try {
                await checkpoint(
                  new Map(
                    claims.map((claim) => [
                      claim.id,
                      { status: "fulfilled", value: { page: { done: true } } },
                    ]),
                  ),
                );
              } finally {
                active--;
              }
            },
          },
        },
        "image.cloud": {
          prepare: async () => {
            images++;
            return { page: { done: true } };
          },
        },
      };
      const draining = drainDueJobs(ctx.db, handlers, 256, 60_000);
      try {
        await Promise.race([
          started.promise,
          draining.then(() => {
            throw new Error("Drain finished before the first embedding page");
          }),
        ]);
        await expect.poll(() => images, { timeout: 20_000 }).toBe(20);
        expect(pages).toEqual([100]);
      } finally {
        release.resolve();
        await draining;
      }
      expect(pages).toEqual([100, 100]);
      expect(peak).toBe(1);
      expect(images).toBe(20);
    },
  );

  it("admits only one background evaluation across concurrent claims and reclaims expired capacity", async () => {
    const flood = [];
    for (let index = 0; index < 12; index++)
      flood.push(
        await enqueueJob(ctx.db, {
          key: `synthetic.capped.${index}`,
          kind: "ai.evaluation",
          input: {},
        }),
      );
    expect(
      (await dueJobs(ctx.db)).filter((row) => row.kind === "ai.evaluation"),
    ).toHaveLength(1);
    const claims = (
      await Promise.all(flood.map((row) => claimJob(ctx.db, row.id)))
    ).filter((claim) => claim !== null);
    expect(claims).toHaveLength(1);
    const first = claims[0]!;
    expect(await dueJobs(ctx.db)).toHaveLength(0);
    const waiting = await loadJobWaitingOn(
      ctx.db,
      flood.filter((row) => row.id !== first.id),
    );
    expect([...waiting.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "due", aheadIsEstimate: true }),
      ]),
    );

    // Historical running rows with lapsed leases do not consume admission.
    await getDb(ctx.db)
      .update(job)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(job.id, first.id));
    expect(
      (await dueJobs(ctx.db)).filter((row) => row.kind === "ai.evaluation"),
    ).toHaveLength(1);
    const reclaimed = await claimJob(ctx.db, first.id);
    expect(reclaimed?.leaseToken).not.toBe(first.leaseToken);
    expect(reclaimed).not.toBeNull();
    if (!reclaimed) return;
    const other = flood.find((row) => row.id !== first.id)!;
    expect(await claimJob(ctx.db, other.id)).toBeNull();
    expect(await releaseJobClaim(ctx.db, reclaimed)).toBe(true);
    expect(await claimJob(ctx.db, other.id)).not.toBeNull();
  });

  it.each(["maintenance", "connection_discovery"] as const)(
    "lets active Run work bypass a saturated kind cap (%s)",
    async (purpose) => {
      const background = await enqueueJob(ctx.db, {
        key: "synthetic.busy",
        kind: "ai.evaluation",
        input: {},
      });
      expect(await claimJob(ctx.db, background.id)).not.toBeNull();
      await enqueueJob(ctx.db, {
        key: "synthetic.cap-waiting",
        kind: "ai.evaluation",
        input: {},
        priority: 100,
      });
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose,
        trigger: "manual",
        execution: false,
      });
      const owned = await enqueueJob(ctx.db, {
        key: "synthetic.cap-owned",
        kind: "ai.evaluation",
        input: {},
        runId,
      });
      const otherKinds = (await dueJobs(ctx.db, 100))
        .filter((row) => row.kind !== "ai.evaluation")
        .map((row) => row.id);
      expect(
        (await dueJobs(ctx.db, 1, { excludeIds: otherKinds })).map(
          (row) => row.id,
        ),
      ).toEqual([owned.id]);
      const execution = await enqueueJob(ctx.db, {
        key: "synthetic.cap-execute",
        kind: "run.execute",
        input: {},
        runId,
      });
      expect((await dueJobs(ctx.db)).map((row) => row.id)).toEqual(
        expect.arrayContaining([owned.id, execution.id]),
      );
      expect(await claimJob(ctx.db, owned.id)).not.toBeNull();
      expect(await claimJob(ctx.db, execution.id)).not.toBeNull();
    },
  );

  it(
    "keeps free lanes draining embeddings, images and new Run work while an evaluation is blocked",
    { timeout: 60_000 },
    async () => {
      for (const [kind, count] of [
        ["ai.evaluation", 20],
        ["embedding.refresh", 90],
        ["image.cloud", 20],
      ] as const)
        for (let index = 0; index < count; index++)
          await enqueueJob(ctx.db, {
            key: `synthetic.blocked.${kind}.${index}`,
            kind,
            input: {},
          });
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        trigger: "manual",
        execution: false,
      });
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const served = new Map<string, number>();
      let runClaimed = false;
      let activeEvaluations = 0;
      let peakEvaluations = 0;
      const handlers: JobHandlers = {
        "ai.evaluation": {
          prepare: async () => {
            activeEvaluations++;
            peakEvaluations = Math.max(peakEvaluations, activeEvaluations);
            started.resolve();
            await release.promise;
            activeEvaluations--;
            return { page: { done: true } };
          },
        },
        "embedding.refresh": {
          prepare: async () => {
            throw new Error("Expected batch execution");
          },
          batch: {
            size: 64,
            execute: async (_db, claims, { checkpoint }) => {
              served.set(
                "embedding.refresh",
                (served.get("embedding.refresh") ?? 0) + claims.length,
              );
              await checkpoint(
                new Map(
                  claims.map((claim) => [
                    claim.id,
                    { status: "fulfilled", value: { page: { done: true } } },
                  ]),
                ),
              );
            },
          },
        },
        "image.cloud": {
          prepare: async () => {
            served.set("image.cloud", (served.get("image.cloud") ?? 0) + 1);
            return { page: { done: true } };
          },
        },
        "run.execute": {
          prepare: async () => {
            runClaimed = true;
            return { page: { done: true } };
          },
        },
      };
      const draining = drainDueJobs(ctx.db, handlers, 256, 50_000);
      try {
        await Promise.race([
          started.promise,
          draining.then(() => {
            throw new Error("Drain finished before starting the evaluation");
          }),
        ]);
        await enqueueJob(ctx.db, {
          key: "synthetic.arriving-run",
          kind: "run.execute",
          input: {},
          runId,
        });
        // More than one widened fair selection must finish before the blocked
        // evaluation releases, including work arriving after it started.
        await expect
          .poll(
            () => ({
              embeddings: served.get("embedding.refresh"),
              images: served.get("image.cloud"),
              runClaimed,
            }),
            { timeout: 20_000 },
          )
          .toEqual({ embeddings: 90, images: 20, runClaimed: true });
        expect(activeEvaluations).toBe(1);
        expect(peakEvaluations).toBe(1);
      } finally {
        release.resolve();
        await draining;
      }
    },
  );

  it(
    "claims every other kind and every run-owned Job within a bound while 100k Jobs of one kind are due",
    { timeout: 180_000 },
    async () => {
      await getDb(ctx.db).execute(sql`
      WITH seeds AS MATERIALIZED (SELECT n, gen_random_uuid() AS id FROM generate_series(1,100000) n), identities AS (
        INSERT INTO "Entity" (id,kind,shortcode) SELECT id,'job','JOB-' || lpad(translate(to_hex(n), '0123456789abcdef', '23456789ABCDEFGH'),10,'2') FROM seeds RETURNING id,shortcode
      ) INSERT INTO "Job" (id,shortcode,key,kind,input,"availableAt")
      SELECT i.id,i.shortcode,'synthetic.flood:' || s.n,'synthetic.flood','{}'::jsonb,
        now() - interval '1 hour' + s.n * interval '1 millisecond' FROM identities i JOIN seeds s ON s.id=i.id`);
      const others: string[] = [];
      for (const kind of ["a.mail", "b.search", "c.image", "d.calendar"])
        for (let index = 0; index < 10; index++)
          others.push(
            (
              await enqueueJob(ctx.db, {
                key: `synthetic.${kind}.${index}`,
                kind,
                input: {},
              })
            ).id,
          );
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        trigger: "manual",
      });
      const owned: string[] = [];
      for (let index = 0; index < 20; index++)
        owned.push(
          (
            await enqueueJob(ctx.db, {
              key: `synthetic.owned.${index}`,
              kind: "synthetic.flood",
              input: {},
              runId,
            })
          ).id,
        );

      // The template starts empty. Give the planner the synthetic flood's
      // actual cardinality rather than waiting for background auto-analyze.
      await getDb(ctx.db).execute(sql`ANALYZE "Job"`);
      const claimedAt = new Map<string, number>();
      let round = 0;
      await drainRounds(ctx.db, 12, (batch) => {
        for (const row of batch) claimedAt.set(row.id, round);
        round++;
      });

      // Run-owned work leads: all 20 within the first round.
      for (const id of owned) expect(claimedAt.get(id)).toBe(0);
      // Every other kind progresses every round despite the flood: 40 Jobs
      // across four kinds finish within ten rounds of 25.
      for (const id of others) expect(claimedAt.get(id)).toBeLessThan(10);
      // The flood still gets a bounded, larger share once others are served.
      const flood = [...claimedAt.keys()].filter(
        (id) => !others.includes(id) && !owned.includes(id),
      );
      expect(flood.length).toBeGreaterThan(50);
    },
  );

  // Widening needs its own prefix in each exemption class. A top-N over the
  // merged backfill would hide low-priority ordinary siblings behind routine
  // Run work after both classes already won seeds.
  it(
    "fills both exemption classes from one selection without losing lower-priority siblings",
    { timeout: 30_000 },
    async () => {
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "connection_discovery",
        trigger: "scheduled",
        execution: false,
      });
      const ordinary: string[] = [];
      const routine: string[] = [];
      for (let index = 0; index < 150; index++) {
        ordinary.push(
          (
            await enqueueJob(ctx.db, {
              key: `synthetic.pool-ordinary.${index}`,
              kind: "embedding.refresh",
              input: {},
              priority: index < 2 ? 100 : 0,
            })
          ).id,
        );
        routine.push(
          (
            await enqueueJob(ctx.db, {
              key: `synthetic.pool-routine.${index}`,
              kind: "embedding.refresh",
              input: {},
              priority: 50,
              runId,
            })
          ).id,
        );
      }
      const selection = { batchSizes: new Map([["embedding.refresh", 100]]) };
      const excluded = ordinary[0]!;
      const selected = await dueJobs(ctx.db, JOB_DRAIN.pageLimit, {
        ...selection,
        excludeIds: [excluded],
      });
      const embeddings = selected.filter(
        (row) => row.kind === "embedding.refresh",
      );
      expect(embeddings.filter((row) => row.capExempt)).toHaveLength(100);
      expect(embeddings.filter((row) => !row.capExempt)).toHaveLength(100);
      expect(new Set(embeddings.map((row) => row.id)).size).toBe(200);
      expect(embeddings.map((row) => row.id)).not.toContain(excluded);
      expect(embeddings.every((row) => !row.runOwned)).toBe(true);
    },
  );

  // Kind-local positions cannot promise the drain's interleaved service order.
  it("flags kind-local queue positions as estimates", async () => {
    const rows = [];
    for (let index = 0; index < JOB_DRAIN.batch + 5; index++)
      rows.push(
        await enqueueJob(ctx.db, {
          key: `synthetic.estimate.${index}`,
          kind: "synthetic.estimate",
          input: {},
        }),
      );
    const waiting = await loadJobWaitingOn(ctx.db, rows);
    const byAhead = [...waiting.values()].flatMap((entry) =>
      entry?.reason === "due" ? [entry] : [],
    );
    expect(byAhead).toHaveLength(rows.length);
    for (const entry of byAhead)
      expect(entry).toMatchObject({
        aheadIsEstimate: true,
      });
  });
});
