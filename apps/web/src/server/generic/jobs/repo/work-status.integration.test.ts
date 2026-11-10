import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  DERIVED_REBUILD_KEY,
  derivedRebuild,
} from "~/server/db/derived-rebuild-schema";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, aiEvaluationRequest } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { seedJobs, updateJobs } from "~/server/generic/jobs/jobs.fixtures";

import { readBackgroundWorkStatus, readWorkActivity } from "./observation";
import { enqueueJob } from "./producer";

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
        lastMovementAt: minutesAgo(finishedMinutes, now),
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
        key: "derived-rebuild",
        title: "Totals and search results stopped updating",
        action: { type: "none" },
      }),
    ]);
  });

  it("reports repeated rebuild failures even after a recent successful pass", async () => {
    const now = new Date();
    await seedRebuild(now, 3, 3);
    const status = await readBackgroundWorkStatus(ctx.db, now);
    expect(status.stuck.map((item) => item.key)).toEqual([
      "derived-rebuild:failing",
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

  it("keeps current failures visible and recognizes obsolete work finishing", async () => {
    const now = new Date();
    const retryReceipt = { retryEvaluationId: crypto.randomUUID() };
    const rows = await getDb(ctx.db)
      .insert(aiEvaluation)
      .values(
        [retryReceipt, null, null, { retryEvaluationId: "invalid" }].map(
          (receipt) => ({
            executionKind: "ai_refresh" as const,
            feature: "field-suggestion",
            workKey: crypto.randomUUID(),
            target: {
              kind: "field" as const,
              entity: "product",
              recordId: crypto.randomUUID(),
              field: "name",
              suggestionIds: [],
            },
            provenance: {
              dependencies: [],
              inputFingerprint: "synthetic",
              optionFingerprint: "synthetic",
              model: null,
            },
            snapshot: {},
            state: "failed" as const,
            receipt,
            error: "Synthetic retained failure",
          }),
        ),
      )
      .returning({ id: aiEvaluation.id });
    const firstRun = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "completed",
      execution: false,
    });
    const secondRun = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "manual",
      status: "completed",
      execution: false,
    });
    await getDb(ctx.db)
      .insert(aiEvaluationRequest)
      .values([
        { runId: firstRun, evaluationId: rows[1]!.id, receipt: retryReceipt },
        { runId: firstRun, evaluationId: rows[2]!.id, receipt: retryReceipt },
        { runId: secondRun, evaluationId: rows[2]!.id },
      ]);
    const failures = async () =>
      (await readBackgroundWorkStatus(ctx.db, now)).stuck.filter(
        (item) => item.key === "ai.evaluation:field-suggestion:failing",
      );
    expect(await failures()).toEqual([
      expect.objectContaining({
        body: "2 work items need attention after failures.",
      }),
    ]);
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ receipt: retryReceipt })
      .where(eq(aiEvaluationRequest.runId, secondRun));
    expect(await failures()).toEqual([
      expect.objectContaining({
        body: "1 work item needs attention after failures.",
      }),
    ]);
    expect(
      (
        await getDb(ctx.db)
          .select({ state: aiEvaluation.state })
          .from(aiEvaluation)
      ).every((row) => row.state === "failed"),
    ).toBe(true);

    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "obsolete", runAt: null, updatedAt: minutesAgo(40, now) });
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "queued", runAt: minutesAgo(40, now), receipt: null })
      .where(eq(aiEvaluation.id, rows[0]!.id));
    const stopped = async () =>
      (await readBackgroundWorkStatus(ctx.db, now)).stuck.filter(
        (item) => item.key === "ai.evaluation:field-suggestion",
      );
    expect(await stopped()).toHaveLength(1);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ updatedAt: minutesAgo(1, now) })
      .where(eq(aiEvaluation.id, rows[1]!.id));
    expect(await stopped()).toEqual([]);
    const activity = await readWorkActivity(ctx.db, now);
    expect(
      activity.streams.find(
        (stream) => stream.kind === "ai.evaluation:field-suggestion",
      ),
    ).toMatchObject({
      due: 1,
      completed: 0,
      completedPerMinute: 0,
      lastCompletedAt: minutesAgo(1, now).toISOString(),
    });
  });
  it("names why stopped work waits, a failing drain unit and unsaved answers", async () => {
    const now = new Date();
    const execution = (
      outcome: "deferred" | "failed",
      finishedMinutes: number,
      deferringMinutes?: number,
    ) => ({
      outcome,
      errorClass: outcome,
      wallMs: 1,
      queryCount: 1,
      queryMs: 1,
      aiCostUsd: null,
      workerVersion: null,
      finishedAt: minutesAgo(finishedMinutes, now).toISOString(),
      ...(deferringMinutes === undefined
        ? {}
        : {
            deferringSince: minutesAgo(deferringMinutes, now).toISOString(),
          }),
    });
    for (const index of [0, 1, 2]) {
      const runId = await ensureRun(ctx.db, ctx.actor, {
        purpose: "maintenance",
        trigger: "manual",
        status: "completed",
        execution: false,
      });
      await enqueueJob(ctx.db, {
        key: `synthetic.deferring.${index}`,
        kind: "run.execute",
        input: {},
        runId,
      });
    }
    await updateJobs(
      ctx.db,
      { kind: "run.execute" },
      {
        // Each deferral re-polls in 15 seconds, so the Jobs are never due
        // for long: only the deferral run's start shows how long they wait.
        waitReason: "provider_capacity",
        availableAt: new Date(now.getTime() + 15_000),
        lastClaimedAt: now,
        lastExecution: execution("deferred", 0, 45),
        updatedAt: now,
      },
    );
    // One deferral that parks a Job for hours is a timer, not stopped work.
    await enqueueJob(ctx.db, {
      key: "synthetic.timer",
      kind: "run.funding-resume",
      input: {},
    });
    await updateJobs(
      ctx.db,
      { key: "synthetic.timer" },
      {
        waitReason: "ai_funding_window",
        availableAt: minutesAgo(-180, now),
        lastExecution: execution("deferred", 45, 45),
      },
    );
    await seedJobs(ctx.db, [
      { key: "drain:synthetic-unit", kind: "background.drain", input: {} },
    ]);
    await updateJobs(
      ctx.db,
      { key: "drain:synthetic-unit" },
      {
        state: "completed",
        lastClaimedAt: minutesAgo(2, now),
        lastExecution: execution("failed", 2),
        failingSince: minutesAgo(50, now),
        error: "Synthetic drain page failure",
      },
    );
    await seedJobs(ctx.db, [
      { key: "drain:synthetic-waiting", kind: "background.drain", input: {} },
      { key: "drain:synthetic-paused", kind: "background.drain", input: {} },
    ]);
    await updateJobs(
      ctx.db,
      { key: "drain:synthetic-waiting" },
      {
        state: "completed",
        lastClaimedAt: minutesAgo(1, now),
        lastExecution: execution("deferred", 1, 40),
      },
    );
    await updateJobs(
      ctx.db,
      { key: "drain:synthetic-paused" },
      {
        state: "completed",
        lastClaimedAt: minutesAgo(40, now),
        lastExecution: execution("deferred", 40, 40),
      },
    );
    const answer = (feature: string) => ({
      executionKind: "ai_refresh" as const,
      feature,
      workKey: crypto.randomUUID(),
      target: {
        kind: "field" as const,
        entity: "product",
        recordId: crypto.randomUUID(),
        field: "name",
        suggestionIds: [],
      },
      provenance: {
        dependencies: [],
        inputFingerprint: "synthetic",
        optionFingerprint: "synthetic",
        model: null,
      },
      snapshot: {},
      state: "result_ready" as const,
    });
    await getDb(ctx.db)
      .insert(aiEvaluation)
      .values([
        // A failed publication waiting out its backoff: owed and unsaved.
        {
          ...answer("field-suggestion"),
          runAt: minutesAgo(-5, now),
          failingSince: minutesAgo(60, now),
          error: JSON.stringify({
            causes: [
              { name: "SnapshotWriteConflictError", message: "synthetic" },
            ],
          }),
        },
        // A funding wait parks its answer on purpose, however old the row.
        {
          ...answer("product-identity"),
          runAt: minutesAgo(-5, now),
          waitCause: "ai_funding_window",
          failingSince: minutesAgo(60, now),
          updatedAt: minutesAgo(60, now),
        },
        // So does a postponement, and a row parked for a stopped requester.
        {
          ...answer("product-identity"),
          runAt: minutesAgo(-5, now),
          updatedAt: minutesAgo(60, now),
        },
        {
          ...answer("product-identity"),
          runAt: null,
          updatedAt: minutesAgo(60, now),
        },
      ]);

    const status = await readBackgroundWorkStatus(ctx.db, now, [
      {
        name: "synthetic",
        due: sql`SELECT * FROM (VALUES
          ('synthetic-owed', false, ${minutesAgo(40, now).toISOString()}::timestamp),
          ('synthetic-fresh', false, ${minutesAgo(5, now).toISOString()}::timestamp)
        ) AS due(unit, demand, since)`,
      },
    ]);
    const item = (key: string) =>
      status.stuck.find((entry) => entry.key === key);
    expect(item("run.execute")).toMatchObject({
      body: expect.stringMatching(
        /^3 Maintenance Runs keep deferring on provider capacity\. Nothing has finished for 45 minutes\./u,
      ),
      diagnostic: expect.stringContaining(
        "run.execute: 3 claimed, 0 succeeded, 3 deferred, 0 failed",
      ),
    });
    expect(item("drain:synthetic-unit:failing")).toMatchObject({
      title: "synthetic-unit keeps failing",
      diagnostic: expect.stringContaining("Synthetic drain page failure"),
    });
    expect(item("run.funding-resume")).toBeUndefined();
    expect(item("drain:synthetic-waiting:deferring")).toMatchObject({
      title: "synthetic-waiting keeps waiting",
      body: "Every pass has deferred for 40 minutes, so this work isn't finishing.",
    });
    expect(item("drain:synthetic-paused:deferring")).toBeUndefined();
    expect(item("drain:synthetic-owed")).toMatchObject({
      title: "synthetic-owed stopped",
      body: "It has never been given a turn. Its work has waited 40 minutes.",
    });
    expect(item("drain:synthetic-fresh")).toBeUndefined();
    expect(item("ai.evaluation:field-suggestion:unpublished")).toMatchObject({
      body: expect.stringContaining("1 AI answer has waited 60 minutes"),
      diagnostic: expect.stringContaining("SnapshotWriteConflictError"),
    });
    expect(item("ai.evaluation:product-identity:unpublished")).toBeUndefined();

    const activity = await readWorkActivity(ctx.db, now);
    expect(
      activity.queue.find((unit) => unit.unit === "run.execute"),
    ).toMatchObject({
      type: "job",
      claimed: 3,
      deferred: 3,
      waits: [
        {
          reason: "provider_capacity",
          runPurpose: "maintenance",
          count: 3,
          deferred: 3,
        },
      ],
    });
    expect(activity.evaluations).toEqual([
      expect.objectContaining({
        feature: "field-suggestion",
        state: "result_ready",
        count: 1,
        errorClass: "SnapshotWriteConflictError",
      }),
      expect.objectContaining({
        feature: "product-identity",
        state: "result_ready",
        count: 3,
      }),
    ]);
  });
});
