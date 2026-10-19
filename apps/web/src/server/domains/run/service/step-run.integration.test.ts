import type { RunId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import { readRunSteps } from "../repo/run-step";
import {
  advanceStepRun,
  recoverStepRuns,
  retryRunStep,
  type StepDriver,
  type StepPage,
  type StepRunDrivers,
} from "./step-run";

const launcher: WorkflowLauncher = {
  create: async () => {},
  terminate: async () => {},
  status: async () => ({ state: "running", error: null }),
};

/** A driver that serves scripted pages and records what it was asked. */
function scripted(key: string, pages: StepPage[]) {
  const seen: { cursor: unknown; retried: unknown }[] = [];
  const driver: StepDriver = {
    key,
    label: `Synthetic ${key}`,
    page: async ({ step }) => {
      seen.push({ cursor: step.cursor, retried: step.meta?.retryRefs });
      const next = pages.shift();
      if (!next) throw new Error(`${key} has no scripted page left`);
      return next;
    },
  };
  return { driver, seen, pages };
}

describe("step-ledger Runs", () => {
  const ctx = withTestDb();

  async function startRun(trigger: "manual" | "scheduled" = "manual") {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger,
      status: "running",
    });
    const launched = await launchWorkflowRun(
      ctx.db,
      { runId: id, purpose: "maintenance" },
      launcher,
    );
    return { id, params: { runId: id, attempt: launched.attempt } };
  }

  async function drive(
    params: { runId: RunId; attempt: number },
    drivers: StepRunDrivers,
    limit = 20,
  ) {
    const kinds: string[] = [];
    for (let page = 0; page < limit; page++) {
      const advance = await advanceStepRun(ctx.db, params, drivers);
      kinds.push(advance.kind);
      if (advance.kind !== "continue") break;
    }
    return kinds;
  }

  const attemptOf = (row: { progress: unknown } | undefined) =>
    z.object({ attempt: z.number() }).parse(row?.progress).attempt;

  const readRun = async (id: RunId) =>
    (await getDb(ctx.db).select().from(run).where(eq(run.id, id)))[0];

  it("pages each step in order, keeps failures with raw errors, and retries only the failed step", async () => {
    const { id, params } = await startRun();
    const exif = scripted("exif", [
      {
        kind: "progress",
        found: 5,
        delta: { done: 2 },
        cursor: 2,
        done: false,
      },
      {
        kind: "progress",
        delta: { done: 2, failed: 1 },
        errors: [
          {
            at: new Date().toISOString(),
            message: "R2 object not found: synthetic/IMG-0001.heic (404)",
            ref: "image:synthetic-1",
          },
        ],
        cursor: 5,
        done: true,
      },
    ]);
    const embed = scripted("embeddings", [
      { kind: "progress", found: 0, done: true },
    ]);
    const drivers: StepRunDrivers = async () => [exif.driver, embed.driver];

    expect(await drive(params, drivers)).toEqual([
      "continue",
      "continue",
      "continue",
      "finished",
    ]);
    expect(exif.seen.map((call) => call.cursor)).toEqual([null, 2]);
    const steps = await readRunSteps(ctx.db, id);
    expect(
      steps.map(({ key, state, found, done, failed, left }) => ({
        key,
        state,
        found,
        done,
        failed,
        left,
      })),
    ).toEqual([
      { key: "exif", state: "failed", found: 5, done: 4, failed: 1, left: 0 },
      {
        key: "embeddings",
        state: "done",
        found: 0,
        done: 0,
        failed: 0,
        left: 0,
      },
    ]);
    expect(steps[0]?.errors[0]).toMatchObject({
      message: "R2 object not found: synthetic/IMG-0001.heic (404)",
      ref: "image:synthetic-1",
    });
    const finished = await readRun(id);
    expect(finished).toMatchObject({
      status: "needs_review",
      failureCode: "step_failures",
      routine: false,
    });
    expect(
      (finished?.progressHistory ?? []).map((event) => event.phase),
    ).toEqual([
      "attempt_started",
      "step_started",
      "step_failed",
      "step_started",
      "finished",
    ]);

    // Retry re-admits only the failed step's failures, not finished steps.
    exif.pages.push({
      kind: "progress",
      delta: { done: 1 },
      cursor: 5,
      done: true,
    });
    await retryRunStep(ctx.db, id, "exif", launcher);
    const relaunched = await readRun(id);
    const attempt = attemptOf(relaunched);
    expect(await drive({ runId: id, attempt }, drivers)).toEqual([
      "continue",
      "finished",
    ]);
    expect(exif.seen.at(-1)?.retried).toEqual(["image:synthetic-1"]);
    expect(embed.seen).toHaveLength(1);
    expect(await readRun(id)).toMatchObject({ status: "completed" });
    // The superseded attempt can no longer write.
    expect(await advanceStepRun(ctx.db, params, drivers)).toEqual({
      kind: "lost",
    });
  });

  it("pauses the Run for a budget window and resumes it only once the window ends", async () => {
    const { id, params } = await startRun();
    const until = new Date(Date.now() + 60 * 60_000);
    const describe = scripted("describe", [
      { kind: "progress", found: 3, delta: { done: 1 }, done: false },
      { kind: "paused", reason: "AI budget exhausted", until },
    ]);
    const drivers: StepRunDrivers = async () => [describe.driver];
    expect(await drive(params, drivers)).toEqual(["continue", "paused"]);
    expect(await readRun(id)).toMatchObject({
      status: "paused_auth",
      failureCode: "execution_limit",
    });
    expect(await recoverStepRuns(ctx.db, launcher, [id])).toBe(0);
    // A raised credit limit resumes the pass before its window ends.
    expect(
      await recoverStepRuns(ctx.db, launcher, [id], new Date(), true),
    ).toBe(1);
    const resumed = await readRun(id);
    expect(resumed?.status).toBe("running");
    describe.pages.push({ kind: "progress", delta: { done: 2 }, done: true });
    const attempt = attemptOf(resumed);
    expect(await drive({ runId: id, attempt }, drivers)).toEqual([
      "continue",
      "finished",
    ]);
    expect((await readRunSteps(ctx.db, id))[0]).toMatchObject({
      state: "done",
      done: 3,
      left: 0,
    });
  });

  it("waits on a child Run and records its totals without double counting", async () => {
    const { id, params } = await startRun();
    const childRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "suggestion_sweep",
      trigger: "manual",
      status: "running",
    });
    const counts = { found: 10, done: 4, failed: 0, skipped: 1 };
    const child = scripted("fields", [
      { kind: "child", childRunId, counts, state: "running" },
      { kind: "child", childRunId, counts, state: "running" },
      {
        kind: "child",
        childRunId,
        counts: { found: 10, done: 9, failed: 0, skipped: 1 },
        state: "done",
      },
    ]);
    const drivers: StepRunDrivers = async () => [child.driver];
    expect(await drive(params, drivers)).toEqual(["wait"]);
    expect(await drive(params, drivers)).toEqual(["wait"]);
    expect((await readRunSteps(ctx.db, id))[0]).toMatchObject({
      state: "waiting",
      childRunId,
      done: 4,
      left: 5,
    });
    expect(await drive(params, drivers)).toEqual(["continue", "finished"]);
    expect((await readRunSteps(ctx.db, id))[0]).toMatchObject({
      state: "done",
      done: 9,
      skipped: 1,
      left: 0,
    });
  });

  it("marks a scheduled pass that found nothing as routine", async () => {
    const { id, params } = await startRun("scheduled");
    const idle = scripted("idle", [{ kind: "progress", found: 0, done: true }]);
    await drive(params, async () => [idle.driver]);
    expect(await readRun(id)).toMatchObject({
      status: "completed",
      routine: true,
    });
  });

  it("fails one step whose page throws and still runs the next step", async () => {
    const { id, params } = await startRun();
    const broken = scripted("broken", []);
    const next = scripted("next", [
      { kind: "progress", found: 1, delta: { done: 1 }, done: true },
    ]);
    await drive(params, async () => [broken.driver, next.driver]);
    const steps = await readRunSteps(ctx.db, id);
    expect(steps.map((step) => step.state)).toEqual(["failed", "done"]);
    expect(steps[0]?.errors[0]?.message).toContain(
      "broken has no scripted page left",
    );
  });

  // Failure mode: retrying an old pass's step while another maintenance pass
  // is active hits the one-active index with a bare constraint error.
  it("refuses to retry a maintenance step while another pass is active", async () => {
    const { id, params } = await startRun();
    const broken = scripted("broken", []);
    await drive(params, async () => [broken.driver]);
    await startRun();
    await expect(retryRunStep(ctx.db, id, "broken", launcher)).rejects.toThrow(
      /is still running or paused; retry this step once it ends/,
    );
    expect((await readRunSteps(ctx.db, id))[0]?.state).toBe("failed");
  });

  // Failure mode (review): the error sample holds 20, so a retry that read it
  // re-admitted 20 failures and silently dropped the rest.
  it("re-admits every failed item on retry, not only the displayed sample", async () => {
    const { id, params } = await startRun();
    const refs = Array.from({ length: 25 }, (_, n) => `image:synthetic-${n}`);
    const exif = scripted("exif", [
      {
        kind: "progress",
        found: 25,
        delta: { failed: 25 },
        errors: refs.map((ref) => ({
          at: new Date().toISOString(),
          message: "R2 object not found (404)",
          ref,
        })),
        done: true,
      },
    ]);
    await drive(params, async () => [exif.driver]);
    expect((await readRunSteps(ctx.db, id))[0]?.errors).toHaveLength(20);
    exif.pages.push({ kind: "progress", delta: { done: 25 }, done: true });
    await retryRunStep(ctx.db, id, "exif", launcher);
    const attempt = attemptOf(await readRun(id));
    await drive({ runId: id, attempt }, async () => [exif.driver]);
    expect(exif.seen.at(-1)?.retried).toEqual(refs);
  });

  // Failure mode (review): reconcile fails a Run whose first dispatch was lost,
  // and recovery only looked at running attempt-0 Runs, so it never relaunched.
  it("relaunches a step-ledger Run that reconcile failed for a lost dispatch", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger: "scheduled",
      status: "running",
    });
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "failed",
        failureCode: "workflow_dispatch_failed",
        dispatchError: "The Run was saved but its Workflow was never started",
      })
      .where(eq(run.id, id));
    expect(await recoverStepRuns(ctx.db, launcher, [id])).toBe(1);
    expect(await readRun(id)).toMatchObject({ status: "running" });
    // A member's cancellation is an outcome, never retried.
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, id));
    expect(await recoverStepRuns(ctx.db, launcher, [id])).toBe(0);
  });

  // Failure mode (#2722 review): recovering yesterday's failed pass while
  // tonight's runs hit Run_one_active_maintenance and aborted catch-up.
  it("leaves a superseded maintenance pass alone and keeps recovering the rest", async () => {
    const { id: old } = await startRun("scheduled");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "workflow_dispatch_failed" })
      .where(eq(run.id, old));
    await startRun("scheduled");
    expect(await recoverStepRuns(ctx.db, launcher, [old])).toBe(0);
    expect(await readRun(old)).toMatchObject({ status: "failed" });
  });

  // Failure mode (#2762 rebase): a funding stop inside a step's AI call ended
  // the maintenance Run (needs_review), taking it from its own Workflow.
  it("leaves a funding stop inside a step to the step engine", async () => {
    const { id } = await startRun("scheduled");
    const { pauseExecutionRun } =
      await import("~/server/domains/run/repo/execution-context");
    await pauseExecutionRun(ctx.db, id, "Waiting for free AI capacity");
    expect(await readRun(id)).toMatchObject({
      status: "running",
      endedAt: null,
    });
  });
});
