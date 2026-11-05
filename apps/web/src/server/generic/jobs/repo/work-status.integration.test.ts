import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { DERIVED_DRAIN_JOB_KEY } from "~/server/db/derived-trigger-ddl";
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

  const seedDrain = async (
    now: Date,
    pageAgeMinutes: number,
    dueMinutes: number,
    published: number,
    attempts = 0,
  ) => {
    await enqueueJob(ctx.db, {
      key: DERIVED_DRAIN_JOB_KEY,
      kind: "derived.drain",
      input: {},
    });
    await updateJobs(
      ctx.db,
      { key: DERIVED_DRAIN_JOB_KEY },
      {
        updatedAt: minutesAgo(pageAgeMinutes, now),
        availableAt: minutesAgo(1, now),
        result: { published },
        attempts,
      },
    );
    await insertWorkItems(ctx.db, [
      {
        drain: DERIVED_DRAIN_JOB_KEY,
        target: "product.dataQuality",
        ref: crypto.randomUUID(),
        priority: 2,
        readyAt: minutesAgo(dueMinutes, now),
      },
    ]);
  };

  it("does not call a drain stuck while its pages publish, whatever is running now", async () => {
    const now = new Date();
    await seedDrain(now, 5, 720, 40);
    const status = await readBackgroundWorkStatus(ctx.db, now);
    expect(status.stuck).toEqual([]);
    expect(status.behind).toBe(true);
  });

  it("alarms when due work has seen no completion for the window", async () => {
    const now = new Date();
    await seedDrain(now, 45, 720, 40);
    const status = await readBackgroundWorkStatus(ctx.db, now);
    expect(status.stuck).toEqual([
      expect.objectContaining({
        key: "derived.drain",
        title: "Totals and search results stopped updating",
        action: { type: "retry", kinds: ["derived.drain"] },
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
        target: "assessment.reviewFacts",
        ref: crypto.randomUUID(),
        priority: 1,
        readyAt: minutesAgo(720, now),
      },
    ]);
    const status = await readBackgroundWorkStatus(ctx.db, now);
    expect(status.stuck).toEqual([]);
    expect(status.behind).toBe(false);
  });

  it("does not count a stale page result while pages keep failing", async () => {
    const now = new Date();
    await seedDrain(now, 3, 720, 40, 15);
    const status = await readBackgroundWorkStatus(ctx.db, now);
    expect(status.stuck.map((item) => item.key)).toEqual(["derived.drain"]);
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
