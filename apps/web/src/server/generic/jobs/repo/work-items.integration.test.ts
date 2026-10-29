import { eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job, workItem } from "~/server/db/retained-tables";

import { defineDrain } from "../service/drain";
import { advanceJob } from "../service/jobs";
import { enqueueJob } from "./producer";
import { claimWork } from "./work-claims";
import { markWork } from "./work-items";

describe("generic WorkItems", () => {
  const ctx = withTestDb();

  const createDrain = async (key: string) => {
    const drain = { key, kind: "synthetic.drain" } as const;
    const saved = await enqueueJob(ctx.db, {
      key,
      kind: drain.kind,
      input: {},
      maxAttempts: null,
    });
    return { drain, jobId: saved.id };
  };

  it("claims by priority, then readyAt", async () => {
    const { drain } = await createDrain("synthetic.work-order");
    const oldest = crypto.randomUUID();
    const newer = crypto.randomUUID();
    const lowerPriority = crypto.randomUUID();
    const now = Date.now();
    await markWork(
      ctx.db,
      drain,
      [{ target: "synthetic", ref: newer, priority: 0 }],
      { readyAt: new Date(now - 60_000) },
    );
    await markWork(
      ctx.db,
      drain,
      [{ target: "synthetic", ref: oldest, priority: 0 }],
      { readyAt: new Date(now - 120_000) },
    );
    await markWork(
      ctx.db,
      drain,
      [{ target: "synthetic", ref: lowerPriority, priority: 1 }],
      { readyAt: new Date(now - 300_000) },
    );

    expect(
      (await claimWork(ctx.db, drain.key, 3)).map((item) => item.ref),
    ).toEqual([oldest, newer, lowerPriority]);
  });

  it("keeps a re-marked item when its older ticket is published", async () => {
    const { drain, jobId } = await createDrain("synthetic.work-ticket");
    const ref = crypto.randomUUID();
    await markWork(ctx.db, drain, [{ target: "synthetic", ref }]);
    const deferred = crypto.randomUUID();
    await markWork(ctx.db, drain, [
      { target: "synthetic", ref: deferred, priority: 1 },
    ]);
    const [before] = await claimWork(ctx.db, drain.key, 1);
    if (!before) throw new Error("Expected WorkItem");
    const [notAdmitted] = await getDb(ctx.db)
      .select()
      .from(workItem)
      .where(eq(workItem.ref, deferred));
    let remarked = false;
    const handler = defineDrain({
      limit: 2,
      admit: (items) => items.slice(0, 1),
      prepare: async (db) => {
        if (!remarked) {
          remarked = true;
          await markWork(db, drain, [{ target: "synthetic", ref }]);
        }
        return { prepared: null };
      },
      publish: async () => {},
    });
    const handlers = { [drain.kind]: handler };

    await expect(advanceJob(ctx.db, jobId, handlers)).resolves.toBe(
      "succeeded",
    );
    const [current] = await getDb(ctx.db)
      .select()
      .from(workItem)
      .where(eq(workItem.ref, ref));
    expect(current?.ticket).toBeGreaterThan(before.ticket);
    expect(current?.attempts).toBe(0);
    expect(
      await getDb(ctx.db)
        .select()
        .from(workItem)
        .where(eq(workItem.ref, deferred)),
    ).toEqual([notAdmitted]);

    await expect(advanceJob(ctx.db, jobId, handlers)).resolves.toBe(
      "succeeded",
    );
    expect(
      await getDb(ctx.db).select().from(workItem).where(eq(workItem.ref, ref)),
    ).toEqual([]);
    await expect(advanceJob(ctx.db, jobId, handlers)).resolves.toBe(
      "succeeded",
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(workItem)
        .where(eq(workItem.ref, deferred)),
    ).toEqual([]);
  });

  it("splits isolated SQL failures, backs off each item, then exhausts at maxAttempts", async () => {
    const { drain, jobId } = await createDrain("synthetic.work-isolation");
    const sqlStates = new Map<string, string>([
      [crypto.randomUUID(), "22000"],
      [crypto.randomUUID(), "23505"],
      [crypto.randomUUID(), "54000"],
    ]);
    const valid = crypto.randomUUID();
    const refs = [...sqlStates.keys(), valid];
    await markWork(
      ctx.db,
      drain,
      refs.map((ref) => ({ target: "synthetic", ref })),
    );
    const published: string[] = [];
    const exhausted: string[] = [];
    const handler = defineDrain({
      limit: 10,
      maxAttempts: 2,
      prepare: async () => ({ prepared: null }),
      publish: async (_tx, items) => {
        const bad = items.find((item) => sqlStates.has(item.ref));
        if (bad) {
          const error = new Error(
            `Synthetic SQLSTATE ${sqlStates.get(bad.ref)}`,
          );
          Object.assign(error, { code: sqlStates.get(bad.ref) });
          throw error;
        }
        published.push(...items.map((item) => item.ref));
      },
      // Each isolated item exhausts alone.
      exhaust: async (_tx, items) => {
        exhausted.push(...items.map((item) => item.ref));
      },
    });
    const handlers = { [drain.kind]: handler };

    await expect(advanceJob(ctx.db, jobId, handlers)).resolves.toBe(
      "succeeded",
    );
    expect(published).toEqual([valid]);
    const retried = await getDb(ctx.db)
      .select()
      .from(workItem)
      .where(inArray(workItem.ref, [...sqlStates.keys()]));
    expect(retried).toHaveLength(3);
    expect(retried.every((item) => item.attempts === 1)).toBe(true);
    expect(retried.every((item) => item.readyAt.getTime() > Date.now())).toBe(
      true,
    );
    expect(retried.map((item) => item.lastError)).toEqual(
      expect.arrayContaining(
        [...sqlStates.values()].map((code) =>
          expect.stringContaining(`SQLSTATE ${code}`),
        ),
      ),
    );

    await getDb(ctx.db)
      .update(workItem)
      .set({ readyAt: new Date(0) })
      .where(inArray(workItem.ref, [...sqlStates.keys()]));
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, jobId));
    await expect(advanceJob(ctx.db, jobId, handlers)).resolves.toBe(
      "succeeded",
    );
    expect(exhausted).toHaveLength(3);
    expect(exhausted).toEqual(expect.arrayContaining([...sqlStates.keys()]));
    expect(
      await getDb(ctx.db)
        .select()
        .from(workItem)
        .where(inArray(workItem.ref, [...sqlStates.keys()])),
    ).toEqual([]);
  });

  it("keeps items the lock declines, backs off a long failure without overflow, then idles", async () => {
    const { drain, jobId } = await createDrain("synthetic.work-lock");
    const foreign = await createDrain("synthetic.work-other-drain");
    const foreignRef = crypto.randomUUID();
    await markWork(ctx.db, foreign.drain, [
      { target: "synthetic", ref: foreignRef },
    ]);
    const [published, declined, failing] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    await markWork(
      ctx.db,
      drain,
      [published, declined, failing].map((ref) => ({
        target: "synthetic",
        ref,
      })),
    );
    await getDb(ctx.db)
      .update(workItem)
      .set({ attempts: 60 })
      .where(eq(workItem.ref, failing));
    const publishedRefs: string[] = [];
    let idled = 0;
    const handler = defineDrain({
      limit: 10,
      chunk: 1,
      prepare: async (db, items) => ({
        prepared: [...items, ...(await claimWork(db, foreign.drain.key, 1))],
        failed: new Map(
          items
            .filter((item) => item.ref === failing)
            .map((item) => [item, new Error("Synthetic compute failure")]),
        ),
      }),
      // A busy source (another writer's lock) leaves its item for a later page.
      lock: async (_tx, items) => items.filter((item) => item.ref !== declined),
      publish: async (_tx, items, observed) => {
        publishedRefs.push(...items.map((item) => item.ref));
        // Coverage cannot steal another drain or a declined, failed or later
        // claim from this page, even when its ticket is still unchanged.
        return { covered: observed };
      },
      idle: async () => {
        idled++;
      },
    });
    const handlers = { [drain.kind]: handler };

    await getDb(ctx.db)
      .update(job)
      .set({ result: { covered: 180 } })
      .where(eq(job.id, jobId));
    await expect(advanceJob(ctx.db, jobId, handlers)).resolves.toBe(
      "succeeded",
    );
    expect(publishedRefs).toEqual([published]);
    const [settled] = await getDb(ctx.db)
      .select({ result: job.result })
      .from(job)
      .where(eq(job.id, jobId));
    expect(settled!.result).toMatchObject({ covered: 0 });
    const rows = await getDb(ctx.db)
      .select()
      .from(workItem)
      .where(eq(workItem.drain, drain.key));
    expect(rows.find((row) => row.ref === declined)).toMatchObject({
      attempts: 0,
      lastError: null,
    });
    const backedOff = rows.find((row) => row.ref === failing);
    expect(backedOff).toMatchObject({
      attempts: 61,
      lastError: expect.stringContaining("Synthetic compute failure"),
    });
    // The server kind's 60 s cap, not 2^60 times the base.
    expect(backedOff!.readyAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 65_000,
    );
    expect(rows.map((row) => row.ref)).not.toContain(published);
    expect(idled).toBe(0);
    expect(
      (await claimWork(ctx.db, foreign.drain.key, 1)).map((item) => item.ref),
    ).toEqual([foreignRef]);

    await getDb(ctx.db).delete(workItem).where(eq(workItem.drain, drain.key));
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, jobId));
    await expect(advanceJob(ctx.db, jobId, handlers)).resolves.toBe(
      "succeeded",
    );
    expect(idled).toBe(1);
  });
});
