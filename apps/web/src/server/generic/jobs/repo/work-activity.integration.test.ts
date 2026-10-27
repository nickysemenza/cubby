import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { job, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import { enqueueJob } from "./producer";
import { readWorkActivity } from "./work-activity";

describe("work activity", () => {
  const ctx = withTestDb();

  it("reports recent Job activity by kind and hides internal maintenance", async () => {
    const now = new Date();
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "running",
      execution: false,
    });
    const owner = (
      await getDb(ctx.db)
        .select({ shortcode: run.shortcode })
        .from(run)
        .where(eq(run.id, runId))
    )[0]!;
    for (const [key, patch] of [
      ["due", { state: "queued", runId }],
      ["backoff", { state: "retry_wait", runId }],
      ["completed", { state: "completed", runId }],
    ] as const) {
      await enqueueJob(ctx.db, {
        key: `synthetic.activity.${key}`,
        kind: "synthetic.activity",
        input: {},
        runId: patch.runId,
      });
      const minutesAgo = key === "completed" ? 2 : 1;
      await getDb(ctx.db)
        .update(job)
        .set({
          state: patch.state,
          availableAt:
            key === "backoff" ? new Date(now.getTime() + 60_000) : new Date(0),
          lastClaimedAt: new Date(now.getTime() - minutesAgo * 60_000),
          updatedAt: new Date(now.getTime() - minutesAgo * 60_000),
        })
        .where(eq(job.key, `synthetic.activity.${key}`));
    }
    await enqueueJob(ctx.db, {
      key: "synthetic.activity.maintenance",
      kind: "jobs.maintenance",
      input: {},
    });

    const activity = await readWorkActivity(
      ctx.db,
      new Date(now.getTime() + 5_000),
    );
    const stream = activity.streams.find(
      (entry) => entry.kind === "synthetic.activity",
    );
    expect(stream).toMatchObject({
      due: 1,
      backingOff: 1,
      completed: 1,
      completedPerMinute: 1 / activity.windows.paceMinutes,
      runIds: [owner.shortcode],
    });
    expect(
      activity.streams.some((entry) => entry.kind === "jobs.maintenance"),
    ).toBe(false);
  });

  it("counts a running Job with an expired lease as waiting work", async () => {
    const now = new Date();
    await enqueueJob(ctx.db, {
      key: "synthetic.activity.expired",
      kind: "synthetic.expired",
      input: {},
    });
    const expiredAt = new Date(now.getTime() - 5 * 60_000);
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "running",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: expiredAt,
        lastClaimedAt: new Date(now.getTime() - 120 * 60_000),
      })
      .where(eq(job.key, "synthetic.activity.expired"));
    const activity = await readWorkActivity(ctx.db, now);
    const stream = activity.streams.find(
      (entry) => entry.kind === "synthetic.expired",
    );
    expect(stream).toMatchObject({ running: 0, due: 1 });
    expect(stream?.oldestDueAt).toBe(expiredAt.toISOString());
  });
});
