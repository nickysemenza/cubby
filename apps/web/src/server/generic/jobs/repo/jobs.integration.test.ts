import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/schema";

import { JOB_HEARTBEAT_MS } from "../limits";
import { advanceJob } from "../service/jobs";
import { enqueueJob, wakeJob } from "./producer";
import { dueJobs } from "./queue";

describe("generic Job execution", () => {
  const ctx = withTestDb();

  it("opens serializable isolation for snapshot-dependent publication", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.serializable-publication",
      kind: "synthetic.serializable",
      input: {},
    });
    await expect(
      advanceJob(ctx.db, saved.id, {
        "synthetic.serializable": {
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
    ).resolves.toBe("succeeded");
    const [stored] = await getDb(ctx.db)
      .select({ result: job.result })
      .from(job)
      .where(eq(job.id, saved.id));
    expect(stored?.result).toEqual({ isolation: "serializable" });
  });

  it("keeps a pass publication and makes a wake during that pass due again", async () => {
    const input = {
      key: "synthetic.wake-during-pass",
      kind: "synthetic.wake",
      input: {},
    };
    const saved = await enqueueJob(ctx.db, input);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pass = advanceJob(ctx.db, saved.id, {
      "synthetic.wake": {
        prepare: async () => {
          entered.resolve();
          await release.promise;
          return {
            page: { done: true },
            publish: async () => ({ published: "first pass" }),
          };
        },
      },
    });
    await entered.promise;
    await wakeJob(ctx.db, input);
    release.resolve();

    await expect(pass).resolves.toBe("succeeded");
    const [completed] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.id, saved.id));
    expect(completed).toMatchObject({
      state: "completed",
      result: { published: "first pass" },
    });
    expect((await dueJobs(ctx.db)).map((candidate) => candidate.id)).toContain(
      saved.id,
    );
  });

  it("aborts the execution signal and fences publication after lease loss", async () => {
    vi.useFakeTimers();
    try {
      const saved = await enqueueJob(ctx.db, {
        key: "synthetic.lease-loss",
        kind: "synthetic.lease-loss",
        input: {},
      });
      const waitingForAbort = Promise.withResolvers<void>();
      let aborted = false;
      let published = false;
      const pass = advanceJob(ctx.db, saved.id, {
        "synthetic.lease-loss": {
          prepare: async (db, claim, context) => {
            await getDb(db)
              .update(job)
              .set({ leaseToken: crypto.randomUUID() })
              .where(eq(job.id, claim.id));
            await new Promise<void>((resolve) => {
              context.signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              );
              waitingForAbort.resolve();
            });
            return {
              page: { done: true },
              publish: async () => {
                published = true;
              },
            };
          },
        },
      });
      await waitingForAbort.promise;
      await vi.advanceTimersByTimeAsync(JOB_HEARTBEAT_MS);

      await expect(pass).resolves.toBe("superseded");
      expect(aborted).toBe(true);
      expect(published).toBe(false);
      expect(
        (await getDb(ctx.db).select().from(job).where(eq(job.id, saved.id)))[0]
          ?.result,
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
