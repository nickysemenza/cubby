import { parseEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { imageProcessingJob, job, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  createImageFixture,
  insertEntityFixtures,
} from "~/server/testing/repo.fixtures";

import { readWorkActivity } from "./observation";
import { enqueueJob } from "./producer";

describe("work activity", () => {
  const ctx = withTestDb();

  it("reports recent Job activity by kind", async () => {
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

  it("reports image work from its own rows, one stream per lane", async () => {
    const now = new Date();
    const image = await createImageFixture(ctx.db, "synthetic-activity-image", {
      sha256: "b".repeat(64),
    });
    const seed = (
      lane: "cloud" | "device",
      kind: "describe_image" | "subject_lift" | "identify_image",
      set: Partial<typeof imageProcessingJob.$inferInsert>,
    ) =>
      insertEntityFixtures(ctx.db, imageProcessingJob, "imageJob", [
        {
          shortcode: generateShortcode("imageJob"),
          imageId: parseEntityId("image", image.id),
          kind,
          lane,
          state: "pending",
          sourceContentHash: "b".repeat(64),
          processorRevision: 1,
          ...set,
        },
      ]);
    await seed("device", "subject_lift", { runAt: new Date(0) });
    await seed("cloud", "describe_image", {
      leaseUntil: new Date(now.getTime() + 60_000),
      attemptId: crypto.randomUUID(),
    });
    await seed("cloud", "identify_image", {
      state: "ready",
      completedAt: new Date(now.getTime() - 60_000),
    });

    const { streams } = await readWorkActivity(ctx.db, now);
    expect(
      streams.find((entry) => entry.kind === "image.device"),
    ).toMatchObject({
      due: 1,
      running: 0,
      oldestDueAt: new Date(0).toISOString(),
    });
    expect(streams.find((entry) => entry.kind === "image.cloud")).toMatchObject(
      {
        due: 0,
        running: 1,
        completed: 1,
      },
    );
  });
});
