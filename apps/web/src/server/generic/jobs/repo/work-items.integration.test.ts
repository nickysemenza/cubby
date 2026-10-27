import { eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job, workItem } from "~/server/db/retained-tables";

import { defineDrain } from "../service/drain";
import { advanceJob } from "../service/jobs";
import { enqueueJob } from "./producer";
import { claimWork, markWork } from "./work-items";

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
    const [before] = await claimWork(ctx.db, drain.key, 1);
    if (!before) throw new Error("Expected WorkItem");
    let remarked = false;
    const handler = defineDrain({
      limit: 1,
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

    await expect(advanceJob(ctx.db, jobId, handlers)).resolves.toBe(
      "succeeded",
    );
    expect(
      await getDb(ctx.db).select().from(workItem).where(eq(workItem.ref, ref)),
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
});
