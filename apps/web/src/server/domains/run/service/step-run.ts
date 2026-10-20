import { buildActorContext } from "@cubby/schemas/context";
import type { RunId } from "@cubby/schemas/identifiers";
import type {
  RunStepCounts,
  RunStepError,
  RunStepMeta,
} from "@cubby/schemas/run-step";
import { createLogger } from "@cubby/worker-tracing";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import type { Database } from "~/server/db";
import {
  isStepRunPurpose,
  STEP_RUN_PURPOSES,
  type StepRunPurpose,
  type WorkflowRunParams,
} from "~/server/workflows/runs/contract";
import {
  type WorkflowLauncher,
  productionWorkflowLauncher,
} from "~/server/workflows/runs/launcher";
import {
  claimWorkflowRun,
  launchWorkflowRun,
  recordRunProgress,
  runFailureText,
} from "~/server/workflows/runs/lifecycle";
import { wakeStepRunParent } from "~/server/workflows/runs/wake";

import {
  ensureRunSteps,
  finishStepRunRow,
  isTerminalStep,
  listRunSteps,
  otherActiveRun,
  pauseStepRun,
  readStepRunOwner,
  recordRunStepPage,
  reopenRunStep,
  stepRunsToRecover,
  type RunStepDefinition,
  type RunStepRow,
  type StepRunOwner,
} from "../repo/run-step";

type RunRow = StepRunOwner;

const log = createLogger("step-run");

/** What one page of a step reported. */
export type StepPage =
  | {
      kind: "progress";
      delta?: Partial<RunStepCounts>;
      /** The backlog size when the driver knows it. */
      found?: number;
      errors?: readonly RunStepError[];
      cursor?: unknown;
      meta?: RunStepMeta;
      /** Nothing is left: the step ends, failed when it recorded failures. */
      done: boolean;
    }
  | {
      /** The step's work runs on a child Run; it ends when the child does. */
      kind: "child";
      childRunId: RunId;
      counts: RunStepCounts;
      state: "running" | "done" | "failed" | "paused";
      errors?: readonly RunStepError[];
      pausedUntil?: Date | null;
      reason?: string;
      /** The driver's own resume point (which child of several is current). */
      cursor?: unknown;
      meta?: RunStepMeta;
      /** Page again now instead of waiting (the driver just moved to its next child). */
      again?: boolean;
    }
  | {
      kind: "paused";
      reason: string;
      until: Date | null;
      /** What the page finished before the pause, kept on the step. */
      delta?: Partial<RunStepCounts>;
      errors?: readonly RunStepError[];
      cursor?: unknown;
    };

export type StepContext = {
  db: Database;
  run: RunRow;
  step: RunStepRow;
  attempt: number;
  /** Launches a step's child Run (tests inject a recording fake). */
  launcher: WorkflowLauncher;
  /** The first page after "Retry failed" reopened this step. */
  retrying: boolean;
};

export interface StepDriver extends RunStepDefinition {
  page(context: StepContext): Promise<StepPage>;
}

/** The ordered drivers a step-ledger Run runs, chosen from its stored input. */
export type StepRunDrivers = (
  db: Database,
  owner: RunRow,
) => Promise<StepDriver[]>;

const registry = {
  maintenance: async () =>
    (await import("~/server/domains/maintenance/service/maintenance-run"))
      .maintenanceDrivers,
  sweep: async () => (await import("./sweep")).sweepDrivers,
} satisfies Record<StepRunPurpose, () => Promise<StepRunDrivers>>;

export type StepAdvance =
  | { kind: "continue" }
  | { kind: "wait"; seconds: number }
  | { kind: "paused" }
  | { kind: "finished" }
  | { kind: "lost" };

const CHILD_WAIT_SECONDS = 60;

let progressSequence = 0;
/** Timeline events within one millisecond still keep their order. */
const stampOf = (attempt: number) => ({
  attempt,
  sequence: Date.now() * 1_000 + (progressSequence++ % 1_000),
});

/**
 * Runs one page of the first unfinished step. Ledger writes happen only while
 * this attempt still owns the Run; a replayed page re-reads the cursor and
 * does the next page, never the same counts twice.
 */
export async function advanceStepRun(
  db: Database,
  params: WorkflowRunParams,
  drivers?: StepRunDrivers,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
): Promise<StepAdvance> {
  const owner = await claimWorkflowRun(db, params);
  if (!owner || !isStepRunPurpose(owner.purpose)) return { kind: "lost" };
  const list = await (drivers ?? (await registry[owner.purpose]()))(db, owner);
  await ensureRunSteps(db, owner.id, list);
  const steps = await listRunSteps(db, owner.id);
  const current = steps.find((step) => !isTerminalStep(step.state));
  if (!current) {
    await finishStepRun(db, owner, steps, params.attempt);
    return { kind: "finished" };
  }
  const driver = list.find((candidate) => candidate.key === current.key);
  if (!driver) {
    await recordRunStepPage(db, owner.id, current.key, {
      state: "failed",
      errors: [failure(`No driver runs step ${current.key}`)],
    });
    return { kind: "continue" };
  }
  const stamp = stampOf(params.attempt);
  // Only a reopened step is queued after it has already run pages.
  const retrying = current.state === "queued" && current.pages > 0;
  if (current.state === "queued" || current.state === "paused") {
    await recordRunStepPage(db, owner.id, current.key, {
      state: "running",
      pausedReason: null,
      pausedUntil: null,
    });
    await recordRunProgress(
      db,
      owner.id,
      current.state === "paused" ? "step_resumed" : "step_started",
      current.label,
      stamp,
    );
  }
  let page: StepPage;
  const started = Date.now();
  try {
    page = await driver.page({
      db,
      run: owner,
      step: current,
      attempt: params.attempt,
      launcher,
      retrying,
    });
  } catch (error) {
    // A thrown page ends this step only; the Run moves on to the next one.
    // The causes carry the Postgres SQLSTATE a driver's "Failed query" hides.
    const message =
      error instanceof Error
        ? [runFailureText(error), scrubErrorMessage(error.stack ?? "")]
            .filter(Boolean)
            .join("\n")
        : runFailureText(String(error));
    log.error("Step page failed", {
      runId: owner.id,
      step: current.key,
      error: message,
    });
    try {
      if (!(await claimWorkflowRun(db, params, "id")))
        return lostAfterPage(db, owner, launcher);
      await recordRunStepPage(db, owner.id, current.key, {
        state: "failed",
        errors: [failure(message)],
      });
      await recordRunProgress(
        db,
        owner.id,
        "step_failed",
        `${current.label}: ${message.split("\n", 1)[0]}`,
        stamp,
      );
    } catch (recordingError) {
      const combined = `${message}\n${runFailureText(new Error("Failure recording failed", { cause: recordingError }))}`;
      log.error("Step failure checkpoint failed", {
        runId: owner.id,
        step: current.key,
        error: combined,
      });
      throw new Error(combined, { cause: recordingError });
    }
    return { kind: "continue" };
  }
  if (!(await claimWorkflowRun(db, params, "id")))
    return lostAfterPage(db, owner, launcher);
  const elapsed = Date.now() - started;
  const timing = {
    timing: {
      lastPageMs: elapsed,
      totalMs: (current.meta?.timing?.totalMs ?? 0) + elapsed,
    },
  };
  if (page.kind === "paused") {
    if (page.delta || page.errors || page.cursor !== undefined)
      await recordRunStepPage(db, owner.id, current.key, {
        ...(page.delta && { delta: page.delta }),
        ...(page.errors && { errors: page.errors }),
        ...(page.cursor !== undefined && { cursor: page.cursor }),
        meta: timing,
      });
    await pauseStep(
      db,
      owner,
      current,
      page.reason,
      page.until,
      params.attempt,
    );
    return { kind: "paused" };
  }
  if (page.kind === "child") {
    const ended = page.state === "done" || page.state === "failed";
    await recordRunStepPage(db, owner.id, current.key, {
      counts: page.counts,
      childRunId: page.childRunId,
      ...(page.errors?.length && { errors: page.errors }),
      ...(page.cursor !== undefined && { cursor: page.cursor }),
      meta: { ...page.meta, ...timing },
      state: ended
        ? page.state === "failed" || page.counts.failed > 0
          ? "failed"
          : "done"
        : "waiting",
    });
    if (page.state === "paused") {
      await pauseStep(
        db,
        owner,
        current,
        page.reason ?? "The step's child Run is paused",
        page.pausedUntil ?? null,
        params.attempt,
      );
      return { kind: "paused" };
    }
    if (ended) {
      await stepEnded(db, owner, current, page.counts, stamp);
      return { kind: "continue" };
    }
    return page.again
      ? { kind: "continue" }
      : { kind: "wait", seconds: CHILD_WAIT_SECONDS };
  }
  const failed = current.failed + (page.delta?.failed ?? 0);
  await recordRunStepPage(db, owner.id, current.key, {
    ...(page.delta && { delta: page.delta }),
    ...(page.found !== undefined && { found: page.found }),
    ...(page.errors && { errors: page.errors }),
    ...(page.cursor !== undefined && { cursor: page.cursor }),
    meta: { ...page.meta, ...timing },
    ...(page.done && { state: failed > 0 ? "failed" : "done" }),
  });
  if (page.done) {
    const [after] = (await listRunSteps(db, owner.id)).filter(
      (step) => step.key === current.key,
    );
    if (after) await stepEnded(db, owner, current, after, stamp);
  }
  return { kind: "continue" };
}

/**
 * A member cancelled the Run while a page ran: cancellation already stopped
 * the children it could see, so stop any this page started after it.
 */
async function lostAfterPage(
  db: Database,
  owner: RunRow,
  launcher: WorkflowLauncher,
): Promise<StepAdvance> {
  const now = await readStepRunOwner(db, owner.id);
  if (now?.status === "failed" && now.failureCode === "user_cancelled") {
    const { cancelStepChildren } =
      await import("~/server/workflows/runs/control");
    await cancelStepChildren(
      db,
      buildActorContext(owner.actorUserId, owner.channel),
      owner.id,
      launcher,
    );
  }
  return { kind: "lost" };
}

const failure = (message: string, ref?: string): RunStepError => ({
  at: new Date().toISOString(),
  message,
  ...(ref && { ref }),
});

async function stepEnded(
  db: Database,
  owner: RunRow,
  step: RunStepRow,
  counts: RunStepCounts,
  stamp: { attempt: number; sequence: number },
) {
  // A step with nothing to do collapses on the ledger; the Timeline skips it.
  if (!counts.found && !counts.failed) return;
  const failures = counts.failed ? ` · ${counts.failed} failed` : "";
  await recordRunProgress(
    db,
    owner.id,
    counts.failed ? "step_failed" : "step_finished",
    `${step.label}: ${counts.done} done of ${counts.found}${failures}`,
    stamp,
  );
}

/**
 * A budget or authorization pause stops the whole Run as `paused_auth` /
 * `execution_limit`, matching AI-work Runs; recovery relaunches it once the
 * window that paused it has ended.
 */
async function pauseStep(
  db: Database,
  owner: RunRow,
  step: RunStepRow,
  reason: string,
  until: Date | null,
  attempt: number,
) {
  await recordRunStepPage(db, owner.id, step.key, {
    state: "paused",
    pausedReason: reason,
    pausedUntil: until,
  });
  const paused = await pauseStepRun(db, owner.id, attempt, reason);
  if (!paused) return;
  await recordRunProgress(
    db,
    owner.id,
    "paused",
    `${step.label}: ${reason}${until ? ` · resumes after ${until.toISOString()}` : ""}`,
    stampOf(attempt),
  );
  await wakeStepRunParent(db, owner.id);
}

async function finishStepRun(
  db: Database,
  owner: RunRow,
  steps: readonly RunStepRow[],
  attempt: number,
) {
  const failed = steps.filter((step) => step.state === "failed");
  const found = steps.reduce((total, step) => total + step.found, 0);
  const finished = await finishStepRunRow(db, owner.id, attempt, {
    failedLabels: failed.map((step) => step.label),
    // A scheduled pass that found nothing is history worth pruning.
    routine: owner.trigger === "scheduled" && found === 0,
  });
  if (!finished) return;
  await recordRunProgress(
    db,
    owner.id,
    "finished",
    failed.length
      ? `Finished · ${failed.length} of ${steps.length} steps with failures`
      : `Finished · ${steps.length} steps`,
    { attempt, sequence: Number.MAX_SAFE_INTEGER },
  );
  await wakeStepRunParent(db, owner.id);
}

/**
 * "Retry failed" on one step: its failures become work again and the Run
 * relaunches from that step; earlier finished steps are not re-run.
 */
export async function retryRunStep(
  db: Database,
  runId: RunId,
  key: string,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
) {
  const owner = await readStepRunOwner(db, runId);
  if (!owner || !isStepRunPurpose(owner.purpose))
    throw new Error("Only a step-ledger Run has steps to retry");
  if (owner.status === "running")
    throw new Error(
      "This Run is still running; retry its failures once it stops.",
    );
  // One maintenance pass at a time (Run_one_active_maintenance).
  const active =
    owner.purpose === "maintenance"
      ? await otherActiveRun(db, owner.purpose, runId)
      : null;
  if (active)
    throw new Error(
      `Maintenance ${active} is still running or paused; retry this step once it ends.`,
    );
  const reopened = await reopenRunStep(db, runId, key);
  if (!reopened) throw new Error("This step has no failures to retry");
  await launchWorkflowRun(
    db,
    { runId, purpose: owner.purpose, retryCancelled: true },
    launcher,
  );
  return reopened;
}

/**
 * Relaunches step-ledger Runs a paused window or a lost handoff left behind:
 * a funding pause whose resume time passed (or any, once the credit limit is
 * raised), or a Run whose attempt was lost. No budget gate here: the funding
 * ladder decides at each call, and a Run still without capacity pauses again
 * before spending. One Run's failed relaunch never stops the rest.
 */
export async function recoverStepRuns(
  db: Database,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
  runIds?: readonly string[],
  now = new Date(),
  budgetRaised = false,
) {
  const candidates = await stepRunsToRecover(
    db,
    STEP_RUN_PURPOSES,
    now,
    runIds,
    budgetRaised,
  );
  let launched = 0;
  for (const candidate of candidates) {
    if (!isStepRunPurpose(candidate.purpose)) continue;
    try {
      if (
        await launchWorkflowRun(
          db,
          { runId: candidate.id, purpose: candidate.purpose, automatic: true },
          launcher,
        )
      )
        launched += 1;
    } catch (error) {
      // SILENT: a concurrent pass took the one-active slot, or the launch
      // failed the Run with its reason; the next catch-up retries the rest.
      log.warn("step-ledger Run did not relaunch", {
        runId: candidate.id,
        error: scrubErrorMessage(String(error)),
      });
    }
  }
  return launched;
}
