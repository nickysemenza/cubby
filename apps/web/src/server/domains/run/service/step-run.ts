import type { RunId } from "@cubby/schemas/identifiers";
import type {
  RunStepCounts,
  RunStepError,
  RunStepMeta,
} from "@cubby/schemas/run-step";

import { scrubErrorMessage } from "~/lib/error-diagnostics";
import { readAiBudget } from "~/server/ai/budget";
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
  | { kind: "paused"; reason: string; until: Date | null };

export type StepContext = {
  db: Database;
  run: RunRow;
  step: RunStepRow;
  attempt: number;
  /** Launches a step's child Run (tests inject a recording fake). */
  launcher: WorkflowLauncher;
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
  try {
    page = await driver.page({
      db,
      run: owner,
      step: current,
      attempt: params.attempt,
      launcher,
    });
  } catch (error) {
    // A thrown page ends this step only; the Run moves on to the next one.
    const message = scrubErrorMessage(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    if (!(await claimWorkflowRun(db, params, "id"))) return { kind: "lost" };
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
    return { kind: "continue" };
  }
  if (!(await claimWorkflowRun(db, params, "id"))) return { kind: "lost" };
  if (page.kind === "paused") {
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
      ...(page.meta && { meta: page.meta }),
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
    ...(page.meta && { meta: page.meta }),
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
  await launchWorkflowRun(db, { runId, purpose: owner.purpose }, launcher);
  return reopened;
}

/**
 * Relaunches step-ledger Runs a paused window or a lost handoff left behind:
 * a budget pause whose window ended, or a `running` Run whose first attempt
 * never started. Concurrent recoveries are harmless (`automatic` launches).
 */
export async function recoverStepRuns(
  db: Database,
  launcher: WorkflowLauncher = productionWorkflowLauncher,
  runIds?: readonly string[],
  now = new Date(),
) {
  const budget = await readAiBudget(db, now);
  const budgetOpen = budget.spentUsd < budget.limitUsd;
  const candidates = await stepRunsToRecover(
    db,
    STEP_RUN_PURPOSES,
    now,
    runIds,
  );
  let launched = 0;
  for (const candidate of candidates) {
    if (!isStepRunPurpose(candidate.purpose)) continue;
    if (candidate.status === "paused_auth" && !budgetOpen) continue;
    if (
      await launchWorkflowRun(
        db,
        { runId: candidate.id, purpose: candidate.purpose, automatic: true },
        launcher,
      )
    )
      launched += 1;
  }
  return launched;
}
