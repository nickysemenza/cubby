import type { RunId } from "@cubby/schemas/identifiers";
import { mailboxDiscoveryProgress } from "@cubby/schemas/mailbox-research";
import type { RunStepDeclaration } from "@cubby/schemas/run-fields";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { run, runOperation, runStep } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { withJobFixtureExecution } from "~/server/testing/background-queue";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import { writeRunningAttemptProgress as writeRunningAttemptProgressImplementation } from "../repo/ai-work-state";
import {
  getRunLiveProgress,
  recordRunProgress as recordRunEventImplementation,
} from "../repo/run-progress";
import { readRunSteps } from "../repo/run-step";
import {
  advanceStepRun as advanceStepRunImplementation,
  retryRunStep,
  type StepDriver,
  type StepPage,
  type StepPlan,
} from "./step-run";

/**
 * A driver that serves scripted pages and records what it was asked. A
 * `total` makes it a `count` step whose COUNT the engine calls.
 */
function scripted(key: string, pages: StepPage[], total?: number) {
  const seen: { cursor: unknown; retried: unknown }[] = [];
  let counts = 0;
  const declaration: RunStepDeclaration = {
    key,
    label: `Synthetic ${key}`,
    purpose: "A synthetic step.",
    action: `Running ${key}`,
    unit: "items",
    input:
      total === undefined
        ? { mode: "tally", reason: "once" }
        : { mode: "count" },
  };
  const driver: StepDriver = {
    ...(total !== undefined && {
      count: async () => {
        counts++;
        return { total, boundary: null };
      },
    }),
    page: async ({ step }) => {
      seen.push({ cursor: step.cursor, retried: step.meta?.retryRefs });
      const next = pages.shift();
      if (!next) throw new Error(`${key} has no scripted page left`);
      return next;
    },
  };
  return { entry: { declaration, driver }, seen, pages, counts: () => counts };
}

const advanceStepRun = (
  ...args: Parameters<typeof advanceStepRunImplementation>
) =>
  withJobFixtureExecution(
    args[0],
    {
      key: `run:${args[1].runId}`,
      kind: "run.execute",
      input: { runId: args[1].runId, purpose: "maintenance" },
      runId: args[1].runId,
    },
    () => advanceStepRunImplementation(...args),
  );

const recordRunEvent = (
  ...args: Parameters<typeof recordRunEventImplementation>
) =>
  withJobFixtureExecution(
    args[0],
    {
      key: `run:${args[1].runId}`,
      kind: "run.execute",
      input: { runId: args[1].runId, purpose: "mail_discovery" },
      runId: args[1].runId,
    },
    () => recordRunEventImplementation(...args),
  );
const writeRunningAttemptProgress = (
  ...args: Parameters<typeof writeRunningAttemptProgressImplementation>
) =>
  withJobFixtureExecution(
    args[0],
    {
      key: `run:${args[1]}`,
      kind: "run.execute",
      input: { runId: args[1], purpose: "mail_discovery" },
      runId: args[1],
    },
    () => writeRunningAttemptProgressImplementation(...args),
  );

describe("step-ledger Runs", () => {
  const ctx = withTestDb();

  async function startRun(trigger: "manual" | "scheduled" = "manual") {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "maintenance",
      trigger,
      status: "running",
    });
    const launched = await launchWorkflowRun(ctx.db, {
      runId: id,
      purpose: "maintenance",
    });
    return { id, params: { runId: id, attempt: launched.attempt } };
  }

  async function drive(
    params: { runId: RunId; attempt: number },
    drivers: StepPlan,
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

  it("retains a capacity deadline across a successor instead of re-admitting early", async () => {
    const { id, params } = await startRun();
    const batch = scripted("capacity", [
      {
        kind: "progress",
        waitSeconds: 60,
        cursor: { after: 1 },
        delta: { done: 1 },
        done: false,
      },
      { kind: "progress", delta: { done: 1 }, done: true },
    ]);
    const drivers = [batch.entry];
    expect(await advanceStepRun(ctx.db, params, drivers)).toMatchObject({
      kind: "continue",
      waitSeconds: 60,
    });
    await getDb(ctx.db)
      .update(job)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(job.key, `run:${params.runId}`));
    const successor = { runId: id, attempt: attemptOf(await readRun(id)) };
    expect(await advanceStepRun(ctx.db, successor, drivers)).toMatchObject({
      kind: "continue",
      waitSeconds: 60,
    });
    expect(batch.seen).toHaveLength(1);
    await getDb(ctx.db).execute(sql`UPDATE "RunStep" SET meta = jsonb_set(meta,
      '{capacityUntil}', to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE "runId" = ${id}`);
    await advanceStepRun(ctx.db, successor, drivers);
    expect((await readRunSteps(ctx.db, id))[0]).toMatchObject({
      done: 2,
      state: "done",
    });
  });

  it("counts a target once after its outcome changes", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic progress member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "product_enrichment",
      trigger: "manual",
      status: "running",
    });
    for (const [index, state] of ["completed", "skipped"].entries())
      await getDb(ctx.db)
        .insert(runOperation)
        .values({
          runId: id,
          operationId: `synthetic-outcome-${index}`,
          kind: "target_outcome",
          state: "completed",
          inputFingerprint: `synthetic-outcome-${index}`,
          result: {
            target: {
              entityKind: "run",
              entityId: id,
              workKey: "synthetic-target",
              state,
              outcome: null,
              warning: null,
              diff: null,
              completedAt: new Date(Date.now() + index * 1_000).toISOString(),
              targetFingerprint: "synthetic-evidence",
            },
          },
        });
    const owner = (await readRun(id))!;
    expect(await getRunLiveProgress(ctx.db, owner.shortcode)).toMatchObject({
      workProgress: { current: { processed: 1 } },
    });
  });

  // Phase history and sampling must survive checkpoint reads; heartbeats are not completed work.
  it("persists non-step phase samples without refreshing an unchanged rate", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic phase member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "running",
      progress: mailboxDiscoveryProgress.parse({
        attempt: 1,
        phase: "listing",
        pagesDone: 1,
        saved: 7,
      }),
    });
    const owner = (await readRun(id))!;
    const at = Date.now() + 1_000;
    const event = (sequence: number) =>
      recordRunEvent(
        ctx.db,
        {
          runId: id,
          eventId: `synthetic:${sequence}`,
          generation: "job:1",
          sequence,
          phase: "synthetic-progress",
        },
        new Date(at + sequence * 1_000),
      );
    await event(0);
    await getDb(ctx.db)
      .update(run)
      .set({
        progress: mailboxDiscoveryProgress.parse({
          attempt: 1,
          phase: "fetching",
          pagesDone: 1,
          saved: 7,
        }),
      })
      .where(eq(run.id, id));
    await event(1);
    const before = (await getRunLiveProgress(ctx.db, owner.shortcode))!
      .workProgress!;
    expect(before.completed).toContainEqual(
      expect.objectContaining({ phase: "listing" }),
    );
    await event(2);
    expect(
      (await getRunLiveProgress(ctx.db, owner.shortcode))!.workProgress!.current
        .sampledAt,
    ).toBe(before.current.sampledAt);
    await getDb(ctx.db)
      .update(run)
      .set({
        progress: mailboxDiscoveryProgress.parse({
          attempt: 1,
          phase: "fetching",
          pagesDone: 1,
          saved: 10,
        }),
      })
      .where(eq(run.id, id));
    await event(3);
    const moving = (await getRunLiveProgress(ctx.db, owner.shortcode))!
      .workProgress!.current;
    await getDb(ctx.db)
      .update(run)
      .set({
        status: "paused_auth",
        progress: mailboxDiscoveryProgress.parse({
          attempt: 1,
          phase: "paused",
          pagesDone: 1,
          saved: 10,
        }),
      })
      .where(eq(run.id, id));
    expect(
      (await getRunLiveProgress(ctx.db, owner.shortcode))!.workProgress!
        .current,
    ).toMatchObject({
      phase: "fetching",
      state: "paused",
      ratePerSecond: moving.ratePerSecond,
      sampledAt: moving.sampledAt,
    });
  });

  // A checkpoint advances completed work even when its heartbeat has not moved.
  it("samples checkpoint progress at its commit time", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic sampling member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const earlier = new Date(Date.now() - 60_000);
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "running",
      progress: mailboxDiscoveryProgress.parse({
        attempt: 1,
        phase: "listing",
        pagesDone: 1,
      }),
    });
    await getDb(ctx.db)
      .update(run)
      .set({ heartbeatAt: earlier })
      .where(eq(run.id, id));
    const owner = (await readRun(id))!;
    await recordRunEvent(
      ctx.db,
      {
        runId: id,
        eventId: "synthetic:sample",
        generation: "job:1",
        sequence: 0,
        phase: "listing",
      },
      earlier,
    );
    await writeRunningAttemptProgress(ctx.db, id, 1, {
      progress: mailboxDiscoveryProgress.parse({
        attempt: 1,
        phase: "listing",
        pagesDone: 2,
      }),
    });
    const current = (await getRunLiveProgress(ctx.db, owner.shortcode))!
      .workProgress!.current;
    expect(Date.parse(current.sampledAt)).toBeGreaterThan(earlier.getTime());
    expect(current.ratePerSecond).toBeGreaterThan(0);
  });

  // Reopening a failed pass must stop presenting its terminal sample before its next page.
  it("resets the active progress sample immediately on a step retry", async () => {
    const { id, params } = await startRun();
    const pages = scripted(
      "synthetic-retry",
      [{ kind: "progress", delta: { done: 1, failed: 1 }, done: true }],
      2,
    );
    await drive(params, [pages.entry]);
    await retryRunStep(ctx.db, id, "synthetic-retry");
    const owner = (await readRun(id))!;
    expect(
      (await getRunLiveProgress(ctx.db, owner.shortcode))!.workProgress!
        .current,
    ).toMatchObject({
      state: "running",
      finished: false,
      processed: 1,
      failures: 0,
    });
  });

  // Step-ledger work has no RunTargets; the shared progress read must still expose real counts.
  it("reports processed items and failures for a Run without targets", async () => {
    const { id, params } = await startRun();
    const pages = scripted(
      "synthetic-items",
      [
        {
          kind: "progress",
          delta: { done: 3, skipped: 1, failed: 1 },
          cursor: "synthetic-next",
          done: false,
        },
      ],
      10,
    );
    await advanceStepRun(ctx.db, params, [pages.entry]);
    // Runs already in flight may have phase samples only for work since a deploy.
    // Read the pre-existing ledger counts; never rewrite the active checkpoint.
    await getDb(ctx.db)
      .update(runStep)
      .set({
        meta: {
          work: {
            current: {
              phase: "synthetic-items",
              label: "Synthetic synthetic-items",
              unit: "items",
              processed: 2,
              total: null,
              failures: 1,
              sampledAt: new Date().toISOString(),
              ratePerSecond: 1,
              finished: false,
            },
            completed: [],
          },
        },
      })
      .where(eq(runStep.runId, id));
    expect(
      (await getRunLiveProgress(ctx.db, (await readRun(id))!.shortcode))
        ?.workProgress?.current,
    ).toMatchObject({ processed: 5, total: 10 });
    const owner = (await readRun(id))!;
    expect(await getRunLiveProgress(ctx.db, owner.shortcode)).toMatchObject({
      workProgress: {
        current: {
          phase: "synthetic-items",
          label: "Synthetic synthetic-items",
          unit: "items",
          processed: 5,
          total: 10,
          failures: 1,
        },
      },
    });
  });

  // Exploratory work must show counts without inventing a zero-sized completed population.
  it("reports an authoritative failed step after an earlier successful sample", async () => {
    const { id, params } = await startRun();
    const pages = scripted(
      "synthetic-failure",
      [
        { kind: "progress", delta: { done: 1 }, done: false },
        {
          kind: "progress",
          delta: { failed: 1 },
          errors: [
            { at: new Date().toISOString(), message: "Synthetic item failed" },
          ],
          done: true,
        },
      ],
      10,
    );
    const drivers: StepPlan = [pages.entry];
    await drive(params, drivers);
    const owner = (await readRun(id))!;
    expect(await getRunLiveProgress(ctx.db, owner.shortcode)).toMatchObject({
      workProgress: { current: { state: "failed", finished: true } },
    });
  });

  it("reports an unknown total for exploratory work with no targets", async () => {
    const id = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      trigger: "manual",
      status: "running",
    });
    const owner = (await readRun(id))!;
    expect(await getRunLiveProgress(ctx.db, owner.shortcode)).toMatchObject({
      workProgress: {
        current: { processed: 0, total: null, failures: 0, etaSeconds: null },
      },
    });
  });

  it("pages each step in order, keeps failures with raw errors, and retries only the failed step", async () => {
    const { id, params } = await startRun();
    const exif = scripted(
      "exif",
      [
        {
          kind: "progress",
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
      ],
      5,
    );
    const embed = scripted("embeddings", [{ kind: "progress", done: true }], 0);
    const drivers: StepPlan = [exif.entry, embed.entry];

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
    ).toEqual(expect.arrayContaining(["step_failed", "finished"]));

    // Retry re-admits only the failed step's failures, not finished steps.
    exif.pages.push({
      kind: "progress",
      delta: { done: 1 },
      cursor: 5,
      done: true,
    });
    await retryRunStep(ctx.db, id, "exif");
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

  // A count step freezes its population once; inputs that left eligibility
  // before the pager reached them end as `removed`, never as 100% done.
  it("freezes a step's count once and ends departed inputs as removed", async () => {
    const { id, params } = await startRun();
    const scan = scripted(
      "scan",
      [
        { kind: "progress", delta: { done: 3 }, cursor: 3, done: false },
        { kind: "progress", delta: { done: 4 }, cursor: 7, done: true },
      ],
      10,
    );
    await advanceStepRun(ctx.db, params, [scan.entry]);
    expect((await readRunSteps(ctx.db, id))[0]).toMatchObject({
      state: "running",
      found: 10,
      done: 3,
      left: 7,
      meta: { input: { mode: "count", total: 10 } },
    });
    await drive(params, [scan.entry]);
    expect(scan.counts()).toBe(1);
    expect((await readRunSteps(ctx.db, id))[0]).toMatchObject({
      state: "done",
      found: 10,
      done: 7,
      left: 0,
      meta: { tallies: { removed: 3 } },
    });
  });

  // A tally step has no denominator: progress never shows a total or ETA.
  it("reports a tally step's work without a total", async () => {
    const { id, params } = await startRun();
    const tally = scripted("tally", [
      { kind: "progress", delta: { done: 4 }, cursor: 4, done: false },
    ]);
    await advanceStepRun(ctx.db, params, [tally.entry]);
    expect((await readRunSteps(ctx.db, id))[0]).toMatchObject({
      found: 0,
      done: 4,
      left: null,
    });
    const owner = (await readRun(id))!;
    expect(await getRunLiveProgress(ctx.db, owner.shortcode)).toMatchObject({
      workProgress: {
        current: { processed: 4, total: null, etaSeconds: null },
      },
    });
  });

  it("marks a scheduled pass that found nothing as routine", async () => {
    const { id, params } = await startRun("scheduled");
    const idle = scripted("idle", [{ kind: "progress", done: true }], 0);
    await drive(params, [idle.entry]);
    expect(await readRun(id)).toMatchObject({
      status: "completed",
      routine: true,
    });
  });

  it("permits the member to retry a failed step on a cancelled Run", async () => {
    const { id, params } = await startRun();
    const broken = scripted(
      "broken",
      [
        {
          kind: "progress",
          delta: { failed: 1 },
          errors: [
            { at: new Date().toISOString(), message: "Synthetic item failed" },
          ],
          done: true,
        },
      ],
      1,
    );
    await drive(params, [broken.entry]);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", failureCode: "user_cancelled" })
      .where(eq(run.id, id));
    await retryRunStep(ctx.db, id, "broken");
    expect(await readRun(id)).toMatchObject({
      status: "running",
      failureCode: null,
    });
    expect((await readRunSteps(ctx.db, id))[0]?.state).toBe("queued");
  });

  // Retrying an old pass while another is active must not hit the unique index.
  it("refuses to retry a maintenance step while another pass is active", async () => {
    const { id, params } = await startRun();
    const broken = scripted(
      "broken",
      [
        {
          kind: "progress",
          delta: { failed: 1 },
          errors: [
            { at: new Date().toISOString(), message: "Synthetic item failed" },
          ],
          done: true,
        },
      ],
      1,
    );
    await drive(params, [broken.entry]);
    await startRun();
    await expect(retryRunStep(ctx.db, id, "broken")).rejects.toThrow(
      /is still running or paused; retry this step once it ends/,
    );
    expect((await readRunSteps(ctx.db, id))[0]?.state).toBe("failed");
  });

  // Failure mode (review): the error sample holds 20, so a retry that read it
  // re-admitted 20 failures and silently dropped the rest.
  it("re-admits every failed item on retry, not only the displayed sample", async () => {
    const { id, params } = await startRun();
    const refs = Array.from({ length: 25 }, (_, n) => `image:synthetic-${n}`);
    const exif = scripted(
      "exif",
      [
        {
          kind: "progress",
          delta: { failed: 25 },
          errors: refs.map((ref) => ({
            at: new Date().toISOString(),
            message: "R2 object not found (404)",
            ref,
          })),
          done: true,
        },
      ],
      25,
    );
    await drive(params, [exif.entry]);
    expect((await readRunSteps(ctx.db, id))[0]?.errors).toHaveLength(20);
    exif.pages.push({ kind: "progress", delta: { done: 25 }, done: true });
    await retryRunStep(ctx.db, id, "exif");
    const attempt = attemptOf(await readRun(id));
    await drive({ runId: id, attempt }, [exif.entry]);
    expect(exif.seen.at(-1)?.retried).toEqual(refs);
  });

  // Failure mode (review): reconcile fails a Run whose first dispatch was lost,
  // and recovery only looked at running attempt-0 Runs, so it never relaunched.
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
