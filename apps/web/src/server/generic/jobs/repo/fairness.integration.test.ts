import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { JOB_DRAIN } from "../limits";
import { drainDueJobs } from "../service/jobs";
import type { JobHandlers } from "../types";
import {
  claimJob,
  dueJobPositions,
  dueJobs,
  enqueueJob,
  releaseJobClaim,
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
    "fills embedding pages to 100 Jobs while other kinds are due",
    { timeout: 30_000 },
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
      const draining = drainDueJobs(ctx.db, handlers, 256);
      try {
        await Promise.race([
          started.promise,
          draining.then(() => {
            throw new Error("Drain finished before the first embedding page");
          }),
        ]);
        await expect.poll(() => images).toBe(20);
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

  // Review finding: diagnostics ranked every run-owned Job ahead of all
  // backfill, but selection reserves backfill a share of each batch, so the
  // reported "ahead" (and the ETA from it) disagreed with the drain.
  it("reports queue positions in the drain's own selection order", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const ids: string[] = [];
    for (let index = 0; index < 25; index++)
      ids.push(
        (
          await enqueueJob(ctx.db, {
            key: `synthetic.owned.${index}`,
            kind: "synthetic.owned",
            input: {},
            runId,
          })
        ).id,
      );
    for (let index = 0; index < 10; index++)
      ids.push(
        (
          await enqueueJob(ctx.db, {
            key: `synthetic.backfill.${index}`,
            kind: "synthetic.backfill",
            input: {},
          })
        ).id,
      );
    const predicted = await dueJobPositions(ctx.db, ids);
    const served: string[] = [];
    // Other due work (the Run's own bookkeeping Jobs) is served too; each
    // position counts every Job the drain serves first.
    await drainRounds(ctx.db, 4, (batch) => {
      served.push(...batch.map((row) => row.id));
    });
    expect(ids.every((id) => served.includes(id))).toBe(true);
    // Exact within the first batch; later batches re-rank kinds by their
    // last service, so a projection is exact to the batch.
    const batchOf = (index: number) => Math.floor(index / JOB_DRAIN.batch);
    expect(
      Object.fromEntries(
        [...predicted].map(([id, ahead]) => [
          id,
          ahead < JOB_DRAIN.batch ? ahead : `batch ${batchOf(ahead)}`,
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        ids.map((id) => {
          const index = served.indexOf(id);
          return [
            id,
            index < JOB_DRAIN.batch ? index : `batch ${batchOf(index)}`,
          ];
        }),
      ),
    );
  });

  it("projects the widened embedding selection with the same Run reserve as the drain", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const ids: string[] = [];
    for (let index = 0; index < 21; index++)
      ids.push(
        (
          await enqueueJob(ctx.db, {
            key: `synthetic.member-batch.${index}`,
            kind: "synthetic.member",
            input: {},
            runId,
          })
        ).id,
      );
    for (let index = 0; index < 6; index++)
      ids.push(
        (
          await enqueueJob(ctx.db, {
            key: `synthetic.embedding-batch.${index}`,
            kind: "embedding.refresh",
            input: {},
          })
        ).id,
      );
    const predicted = await dueJobPositions(ctx.db, ids);
    const selected = await dueJobs(ctx.db, JOB_DRAIN.pageLimit, {
      batchSizes: new Map([["embedding.refresh", 100]]),
    });
    const selectedIds = new Set<string>(selected.map((row) => row.id));
    expect(
      selected.filter((row) => row.kind === "synthetic.member"),
    ).toHaveLength(20);
    expect(
      selected.filter((row) => row.kind === "embedding.refresh"),
    ).toHaveLength(6);
    expect(
      Object.fromEntries([...predicted].filter(([id]) => selectedIds.has(id))),
    ).toEqual(
      Object.fromEntries(
        selected.flatMap((row, index) =>
          ids.includes(row.id) ? [[row.id, index]] : [],
        ),
      ),
    );
    for (const id of ids.filter((id) => !selectedIds.has(id)))
      expect(predicted.get(id)).toBeGreaterThanOrEqual(JOB_DRAIN.batch);
  });

  // Review finding: beyond the first batch the drain re-ranks kinds by their
  // last service, so a position there is a projection, not a promise.
  it("flags queue positions beyond the first batch as estimates", async () => {
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
        aheadIsEstimate: entry.aheadCount >= JOB_DRAIN.batch,
      });
  });
});
