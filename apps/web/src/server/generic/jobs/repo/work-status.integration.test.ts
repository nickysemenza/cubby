import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  DERIVED_REBUILD_KEY,
  derivedRebuild,
} from "~/server/db/derived-rebuild-schema";
import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
import { getDb } from "~/server/db/helpers";
import {
  insertWorkItems,
  updateJobs,
} from "~/server/generic/jobs/jobs.fixtures";

import { enqueueJob } from "./producer";
import { readBackgroundWorkStatus } from "./work-status";

const minutesAgo = (minutes: number, now: Date) =>
  new Date(now.getTime() - minutes * 60_000);

describe("background work status", () => {
  const ctx = withTestDb();

  const seedRebuild = async (
    now: Date,
    finishedMinutes: number,
    failures = 0,
  ) => {
    await getDb(ctx.db).delete(derivedRebuild);
    await getDb(ctx.db)
      .insert(derivedRebuild)
      .values({
        key: DERIVED_REBUILD_KEY,
        running: true,
        target: "product.price",
        startedAt: minutesAgo(finishedMinutes + 60, now),
        finishedAt: minutesAgo(finishedMinutes, now),
        failures,
        error: failures ? "Synthetic rebuild failure" : null,
      });
  };

  it("does not call the hourly pass stuck between scheduled completions", async () => {
    const now = new Date();
    await seedRebuild(now, 40);
    const status = await readBackgroundWorkStatus(ctx.db, now);
    expect(status.stuck).toEqual([]);
    expect(status.behind).toBe(false);
  });

  it("alarms only after two hourly completions are missed", async () => {
    const now = new Date();
    await seedRebuild(now, 125);
    const status = await readBackgroundWorkStatus(ctx.db, now);
    expect(status.stuck).toEqual([
      expect.objectContaining({
        key: "derived.drain",
        title: "Totals and search results stopped updating",
        action: { type: "none" },
      }),
    ]);
  });

  it("does not call an idle drain stuck over tickets it never claims", async () => {
    const now = new Date();
    await enqueueJob(ctx.db, {
      key: DERIVED_DRAIN_JOB_KEY,
      kind: "derived.drain",
      input: {},
    });
    await updateJobs(
      ctx.db,
      { key: DERIVED_DRAIN_JOB_KEY },
      { state: "completed", updatedAt: minutesAgo(600, now) },
    );
    await insertWorkItems(ctx.db, [
      {
        drain: DERIVED_DRAIN_JOB_KEY,
        target: "product.dataQuality",
        ref: crypto.randomUUID(),
        priority: 1,
        readyAt: minutesAgo(720, now),
      },
    ]);
    const status = await readBackgroundWorkStatus(ctx.db, now);
    expect(status.stuck).toEqual([]);
    expect(status.behind).toBe(false);
  });

  it("reports repeated rebuild failures even after a recent successful pass", async () => {
    const now = new Date();
    await seedRebuild(now, 3, 3);
    const status = await readBackgroundWorkStatus(ctx.db, now);
    expect(status.stuck.map((item) => item.key)).toEqual([
      "derived.drain:failing",
    ]);
  });

  it("clears a failed kind once a later Job of that kind completes", async () => {
    const now = new Date();
    for (const key of ["failed", "done"])
      await enqueueJob(ctx.db, {
        key: `synthetic.status.${key}`,
        kind: "synthetic.status",
        input: {},
      });
    await updateJobs(
      ctx.db,
      { key: "synthetic.status.failed" },
      {
        state: "failed",
        error: "Synthetic failure",
        attempts: 3,
        updatedAt: minutesAgo(10, now),
      },
    );
    const failing = await readBackgroundWorkStatus(ctx.db, now);
    expect(failing.stuck).toEqual([
      expect.objectContaining({
        key: "synthetic.status:failing",
        action: {
          type: "retry",
          kinds: ["synthetic.status"],
          needsAttention: true,
        },
      }),
    ]);
    await updateJobs(
      ctx.db,
      { key: "synthetic.status.done" },
      {
        state: "completed",
        lastClaimedAt: minutesAgo(2, now),
        updatedAt: minutesAgo(1, now),
      },
    );
    expect((await readBackgroundWorkStatus(ctx.db, now)).stuck).toEqual([]);
  });
});
