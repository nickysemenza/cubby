import { inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { JOB_DRAIN } from "../limits";
import { dueJobPositions, dueJobs, enqueueJob } from "./jobs";
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
    "claims every other kind and every run-owned Job within a bound while 100k Jobs of one kind are due",
    { timeout: 180_000 },
    async () => {
      await getDb(ctx.db).execute(sql`
      INSERT INTO "Job" (key, kind, input, "availableAt")
      SELECT 'synthetic.flood:' || n, 'synthetic.flood', '{}'::jsonb,
        now() - interval '1 hour' + n * interval '1 millisecond'
      FROM generate_series(1, 100000) n`);
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
