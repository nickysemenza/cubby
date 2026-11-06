import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withSnapshotWriteDatabase } from "~/server/db/helpers";
import { job } from "~/server/db/schema";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { failJob, claimJob } from "~/server/generic/jobs/repo/queue";

import { JobDeferredError, JobPausedError } from "../errors";
import { advanceJob } from "../service/jobs";
import { nextJobDue } from "./queue";

describe("Job retry policy", () => {
  const ctx = withTestDb();
  const read = async (id: string) =>
    (await getDb(ctx.db).select().from(job).where(eq(job.id, id)))[0]!;
  const makeDue = (id: string) =>
    getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, id));

  it("counts an expired lease as an attempt and exhausts at maxAttempts", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.expired-lease",
      kind: "synthetic.expired-lease",
      input: {},
      maxAttempts: 1,
    });
    const first = await claimJob(ctx.db, saved.id, 1_000);
    expect(first?.attempts).toBe(0);
    expect(await nextJobDue(ctx.db)).toEqual(first!.leaseExpiresAt);
    await getDb(ctx.db)
      .update(job)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(job.id, saved.id));

    expect(await claimJob(ctx.db, saved.id)).toBeNull();
    expect(await read(saved.id)).toMatchObject({
      state: "failed",
      attempts: 1,
    });
  });

  it("does not exhaust a Job whose maxAttempts is null", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.unbounded-retry",
      kind: "synthetic.unbounded-retry",
      input: {},
      maxAttempts: null,
    });
    for (let failure = 1; failure <= 4; failure++) {
      await makeDue(saved.id);
      const claim = await claimJob(ctx.db, saved.id);
      if (!claim) throw new Error(`Expected claim ${failure}`);
      await failJob(ctx.db, claim, new Error("Synthetic page failure"));
      expect(await read(saved.id)).toMatchObject({
        state: "retry_wait",
        attempts: failure,
        maxAttempts: null,
      });
    }
  });

  // Database contention may exhaust the in-request transaction replay, but must not
  // abandon durable work or duplicate committed publication on its later retry.
  it("recovers a serialization failure after the Job attempt budget", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.serialization-recovery",
      kind: "synthetic.serialization-recovery",
      input: {},
      maxAttempts: 1,
    });
    let calls = 0;
    const handlers = {
      "synthetic.serialization-recovery": {
        prepare: async () => {
          calls++;
          if (calls <= 2)
            await withSnapshotWriteDatabase(
              ctx.db,
              async () => {
                throw new Error("Synthetic query wrapper", {
                  cause: Object.assign(
                    new Error("Synthetic concurrent update"),
                    { code: "40001" },
                  ),
                });
              },
              { isolationLevel: "serializable" },
            );
          return { page: { done: true } };
        },
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await advanceJob(ctx.db, saved.id, handlers);
      expect(await read(saved.id)).toMatchObject({ state: "retry_wait" });
      await makeDue(saved.id);
    }
    await advanceJob(ctx.db, saved.id, handlers);
    expect(await read(saved.id)).toMatchObject({ state: "completed" });
    expect(calls).toBe(3);
  });

  it("defers without spending an attempt", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.defer",
      kind: "synthetic.defer",
      input: {},
    });
    const until = new Date(Date.now() + 60_000);
    await expect(
      advanceJob(ctx.db, saved.id, {
        "synthetic.defer": {
          prepare: async () => {
            throw new JobDeferredError(
              "Synthetic provider wait",
              until,
              "provider_capacity",
            );
          },
        },
      }),
    ).resolves.toBe("deferred");
    expect(await nextJobDue(ctx.db)).toEqual(until);
    expect(await read(saved.id)).toMatchObject({
      state: "queued",
      attempts: 0,
      waitReason: "provider_capacity",
      waitUntil: until,
      availableAt: until,
    });
  });

  it("pauses the Job when its handler stops the page", async () => {
    const saved = await enqueueJob(ctx.db, {
      key: "synthetic.pause",
      kind: "synthetic.pause",
      input: {},
    });
    await expect(
      advanceJob(ctx.db, saved.id, {
        "synthetic.pause": {
          prepare: async () => {
            throw new JobPausedError("Synthetic member pause");
          },
        },
      }),
    ).resolves.toBe("paused");
    expect(await nextJobDue(ctx.db)).toBeNull();
    expect(await read(saved.id)).toMatchObject({
      state: "paused",
      attempts: 0,
    });
  });
});
