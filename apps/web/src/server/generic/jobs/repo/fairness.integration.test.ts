import { jobState } from "@cubby/schemas/job";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { defineDrain } from "../service/drain";
import { drainDueJobs } from "../service/jobs";
import { enqueueJob, enqueueJobs } from "./producer";
import { dueJobs } from "./queue";
import { markWork } from "./work-items";

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
    await enqueueJobs(ctx.db, flood);
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

  it("enforces maxInFlight across concurrent drains", async () => {
    const kind = "ai.evaluation";
    const ids = await Promise.all(
      [0, 1, 2].map(async (index) => {
        const key = `synthetic.capped-drain.${index}`;
        const item = await enqueueJob(ctx.db, {
          key,
          kind,
          input: {},
          maxAttempts: null,
        });
        await markWork(ctx.db, { key, kind }, [
          { target: "synthetic", ref: crypto.randomUUID() },
        ]);
        return item.id;
      }),
    );
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const handler = defineDrain({
      limit: 1,
      prepare: async () => {
        active++;
        peak = Math.max(peak, active);
        if (active === 2) started.resolve();
        await release.promise;
        active--;
        return { prepared: null };
      },
      publish: async () => {},
    });
    const handlers = { [kind]: handler };
    const first = drainDueJobs(ctx.db, handlers, 1, 30_000, 1);
    try {
      await expect.poll(() => active, { timeout: 10_000 }).toBe(1);
      const second = drainDueJobs(ctx.db, handlers, 1, 30_000, 1);
      await started.promise;
      const third = await drainDueJobs(ctx.db, handlers, 1, 30_000, 1);
      expect(third).toEqual(["skipped"]);
      const rows = await getDb(ctx.db)
        .select({ id: job.id, state: job.state })
        .from(job)
        .where(eq(job.kind, kind));
      expect(
        rows.filter((row) => row.state === jobState.enum.running),
      ).toHaveLength(2);
      expect(
        rows.filter((row) => row.state === jobState.enum.queued),
      ).toHaveLength(1);
      release.resolve();
      await Promise.all([first, second]);
    } finally {
      release.resolve();
    }
    expect(peak).toBe(2);
    await drainDueJobs(ctx.db, handlers, 1, 30_000, 1);
    expect(
      (await getDb(ctx.db).select().from(job).where(eq(job.kind, kind))).every(
        (row) => row.state === "completed",
      ),
    ).toBe(true);
    expect(ids).toHaveLength(3);
  });
});
