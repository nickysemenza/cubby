import type { RunId } from "@cubby/schemas/identifiers";
import {
  isExecutedRunPurpose,
  isStepRunPurpose,
  RUN_KINDS,
  sweepRunInput,
  type RunStepDeclaration,
} from "@cubby/schemas/run-fields";
import type {
  RunStepCounts,
  RunStepError,
  RunStepInput,
  RunStepMeta,
} from "@cubby/schemas/run-step";

type JsonValue = RunStepInput["boundary"];

import type { Database } from "~/server/db";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";
import {
  claimWorkflowRun,
  launchWorkflowRun,
  recordRunProgress,
} from "~/server/workflows/runs/lifecycle";

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
  startRunStep,
  type RunStepRow,
  type StepRunOwner,
} from "../repo/run-step";
import { sampleRunWork, stepWorkSamples } from "../repo/work-progress";
import { stepDriversFor } from "./run-step-registry";

type RunRow = StepRunOwner;
type Tallies = Record<string, number>;

/** What one page of a step reported. Counts are this page's increments. */
export type StepPage =
  | {
      kind: "progress";
      delta?: Partial<Omit<RunStepCounts, "found">>;
      errors?: readonly RunStepError[];
      cursor?: unknown;
      meta?: Pick<RunStepMeta, "detail" | "retryRefs">;
      /** Running counts without a denominator (candidates, decisions). */
      tallies?: Tallies;
      /** Why inputs produced no result on this page (`no_candidate`). */
      reasons?: Tallies;
      /**
       * Whole-step tallies and reasons that replace the stored ones: a wait
       * step re-reads absolute evaluation states on every page.
       */
      absolute?: true;
      /** The current action when narrower than the declared one. */
      action?: string;
      /** An `estimate` step's provider-reported "about N". */
      estimate?: number | null;
      waitSeconds?: number;
      /** Nothing is left: the step ends, failed when it recorded failures. */
      done: boolean;
    }
  | {
      kind: "paused";
      reason: string;
      until: Date | null;
      /** What the page finished before the pause, kept on the step. */
      delta?: Partial<Omit<RunStepCounts, "found">>;
      errors?: readonly RunStepError[];
      cursor?: unknown;
      tallies?: Tallies;
      reasons?: Tallies;
    };

export type StepContext = {
  db: Database;
  run: RunRow;
  step: RunStepRow;
  declaration: RunStepDeclaration;
  attempt: number;
  /** The first page after "Retry failed" reopened this step. */
  retrying: boolean;
  /** The population cutoff the step froze with its count; pagers apply it. */
  boundary: JsonValue | null;
};

/** One COUNT over the same predicate the pager walks, with the cutoff it pages under. */
export type StepCounter = (context: StepContext) => Promise<{
  total: number;
  boundary: JsonValue | null;
}>;

export type StepDriver = {
  count?: StepCounter;
  page(context: StepContext): Promise<StepPage>;
};

/** The ordered declarations and drivers one Run pages; tests pass their own. */
export type StepPlan = readonly {
  declaration: RunStepDeclaration;
  driver: StepDriver;
}[];

/** A Sweep runs the declared steps of the families its input chose, in declared order. */
async function planForRun(owner: RunRow): Promise<StepPlan> {
  if (!isStepRunPurpose(owner.purpose) || !isExecutedRunPurpose(owner.purpose))
    throw new Error(`${owner.purpose} Runs are not executed by run.execute`);
  const families =
    owner.purpose === "sweep"
      ? new Set<string>(
          sweepRunInput
            .parse(owner.input)
            .families.map((entry) => entry.family),
        )
      : null;
  const drivers = await stepDriversFor(owner.purpose);
  const declarations: readonly RunStepDeclaration[] =
    RUN_KINDS[owner.purpose].steps;
  return declarations
    .filter(
      (declaration) =>
        !families || !declaration.family || families.has(declaration.family),
    )
    .flatMap((declaration) => {
      const driver = drivers[declaration.key];
      return driver ? [{ declaration, driver }] : [];
    });
}

export type StepAdvance =
  | { kind: "continue"; waitSeconds?: number }
  | { kind: "paused" }
  | { kind: "finished" }
  | { kind: "lost" };

let progressSequence = 0;
/** Timeline events within one millisecond still keep their order. */
const stampOf = (attempt: number) => ({
  attempt,
  sequence: Date.now() * 1_000 + (progressSequence++ % 1_000),
});

const addTallies = (left: Tallies | undefined, right: Tallies | undefined) => {
  if (!right) return left;
  const sum = { ...left };
  for (const [key, value] of Object.entries(right))
    if (value) sum[key] = (sum[key] ?? 0) + value;
  return sum;
};

/** Only a frozen count is a denominator; estimates and tallies have no %/ETA. */
const denominatorOf = (step: RunStepRow) =>
  step.meta?.input?.mode === "count" ? step.found : null;

function stepWork(
  step: RunStepRow,
  declaration: RunStepDeclaration,
  counts: Omit<RunStepCounts, "found">,
  removed: number,
  started: number,
  finished: boolean,
  reset: boolean,
) {
  return sampleRunWork(
    stepWorkSamples(step),
    {
      phase: step.key,
      label: step.label,
      unit: declaration.unit,
      processed: counts.done + counts.skipped + counts.failed + removed,
      total: denominatorOf(step),
      failures: counts.failed,
    },
    {
      startedAt: new Date(started),
      sampledAt: new Date(),
      finished,
      reset,
      baselineProcessed: reset
        ? step.done + step.skipped + step.failed
        : undefined,
    },
  );
}

function remainingStepWaitSeconds(step: RunStepRow): number | null {
  const nextAt = step.meta?.capacityUntil
    ? Date.parse(step.meta.capacityUntil)
    : 0;
  return nextAt > Date.now()
    ? Math.max(1, Math.ceil((nextAt - Date.now()) / 1000))
    : null;
}

/**
 * Freezes a step's population once per step generation, before its first
 * page. Resume, retry and every read reuse the stored count.
 */
async function freezeStepInput(
  context: StepContext,
  driver: StepDriver,
): Promise<{ found: number; input: RunStepInput }> {
  const countedAt = new Date().toISOString();
  const { mode } = context.declaration.input;
  if (mode !== "count")
    return {
      found: 0,
      input: { mode, total: null, boundary: null, countedAt },
    };
  if (!driver.count)
    throw new Error(
      `Step ${context.declaration.key} declares count without one`,
    );
  const counted = await driver.count(context);
  return {
    found: counted.total,
    input: {
      mode,
      total: counted.total,
      boundary: counted.boundary,
      countedAt,
    },
  };
}

export async function advanceStepRun(
  db: Database,
  params: WorkflowRunParams,
  plan?: StepPlan,
): Promise<StepAdvance> {
  const owner = await claimWorkflowRun(db, params);
  if (!owner || !isStepRunPurpose(owner.purpose)) return { kind: "lost" };
  const steps = plan ?? (await planForRun(owner));
  await ensureRunSteps(
    db,
    owner.id,
    steps.map((entry) => entry.declaration),
  );
  const rows = await listRunSteps(db, owner.id);
  const next = rows.find((step) => !isTerminalStep(step.state));
  if (!next) {
    await finishStepRun(db, owner, rows, params.attempt);
    return { kind: "finished" };
  }
  const entry = steps.find((step) => step.declaration.key === next.key);
  if (!entry) {
    await recordRunStepPage(db, owner.id, next.key, {
      state: "failed",
      errors: [failure(`No driver runs step ${next.key}`)],
    });
    return { kind: "continue" };
  }
  const stamp = stampOf(params.attempt);
  const waitSeconds = remainingStepWaitSeconds(next);
  if (waitSeconds !== null) return { kind: "continue", waitSeconds };
  // Only a reopened step is queued after it has already run pages.
  const retrying = next.state === "queued" && next.pages > 0;
  const context = (step: RunStepRow): StepContext => ({
    db,
    run: owner,
    step,
    declaration: entry.declaration,
    attempt: params.attempt,
    retrying,
    boundary: step.meta?.input?.boundary ?? null,
  });
  let step = next;
  if (next.state === "queued" || next.state === "paused") {
    const frozen = next.meta?.input
      ? null
      : await freezeStepInput(context(next), entry.driver);
    const started = await startRunStep(db, owner.id, next.key, frozen);
    if (!started) return { kind: "lost" };
    step = started;
    await recordRunProgress(
      db,
      owner.id,
      step.pages > 0 && !retrying ? "step_resumed" : "step_started",
      frozen?.input.mode === "count"
        ? `${step.label}: ${frozen.found} ${entry.declaration.unit}`
        : step.label,
      stamp,
    );
  }
  const started = Date.now();
  const page = await entry.driver.page(context(step));
  if (!(await claimWorkflowRun(db, params, "id")))
    return lostAfterPage(db, owner);
  return recordStepPage(db, owner, step, {
    declaration: entry.declaration,
    page,
    started,
    retrying,
    attempt: params.attempt,
    stamp,
  });
}

/** Folds one page into its step: counts, tallies, `removed`, meta and events. */
async function recordStepPage(
  db: Database,
  owner: RunRow,
  step: RunStepRow,
  input: {
    declaration: RunStepDeclaration;
    page: StepPage;
    started: number;
    retrying: boolean;
    attempt: number;
    stamp: { attempt: number; sequence: number };
  },
): Promise<StepAdvance> {
  const { page, started, retrying, stamp } = input;
  const elapsed = Date.now() - started;
  const counts = {
    done: step.done + (page.delta?.done ?? 0),
    skipped: step.skipped + (page.delta?.skipped ?? 0),
    failed: step.failed + (page.delta?.failed ?? 0),
  };
  const ending = page.kind === "progress" && page.done;
  const absolute = page.kind === "progress" && page.absolute;
  let tallies = absolute
    ? page.tallies
    : addTallies(step.meta?.tallies, page.tallies);
  // Inputs that left eligibility after the count froze end as `removed`, so
  // a finished count step always accounts for its whole population.
  if (ending && denominatorOf(step) !== null) {
    const removed = Math.max(
      0,
      step.found -
        counts.done -
        counts.skipped -
        counts.failed -
        (tallies?.removed ?? 0),
    );
    if (removed) tallies = addTallies(tallies, { removed });
  }
  const meta: RunStepMeta = {
    ...(page.kind === "progress" && page.meta),
    ...(tallies && { tallies }),
    ...(page.reasons && {
      reasons: absolute
        ? page.reasons
        : addTallies(step.meta?.reasons, page.reasons),
    }),
    ...(page.kind === "progress" && { action: page.action ?? null }),
    ...(page.kind === "progress" &&
      page.estimate !== undefined &&
      step.meta?.input && {
        input: { ...step.meta.input, total: page.estimate },
      }),
    capacityUntil:
      page.kind === "progress" && page.waitSeconds
        ? new Date(Date.now() + page.waitSeconds * 1000).toISOString()
        : null,
    timing: {
      lastPageMs: elapsed,
      totalMs: (step.meta?.timing?.totalMs ?? 0) + elapsed,
    },
    work: stepWork(
      step,
      input.declaration,
      counts,
      tallies?.removed ?? 0,
      started,
      ending,
      retrying,
    ),
  };
  if (meta.work)
    meta.work.current.activity =
      page.kind === "progress" && page.waitSeconds ? "capacity" : "publishing";
  await recordRunStepPage(db, owner.id, step.key, {
    ...(page.delta && { delta: page.delta }),
    ...(page.errors && { errors: page.errors }),
    ...(page.cursor !== undefined && { cursor: page.cursor }),
    meta,
    ...(ending && { state: counts.failed > 0 ? "failed" : "done" }),
  });
  if (page.kind === "paused") {
    await pauseStep(db, owner, step, page.reason, page.until, input.attempt);
    return { kind: "paused" };
  }
  if (ending) await stepEnded(db, owner, step, counts, stamp);
  return {
    kind: "continue",
    ...(page.waitSeconds && { waitSeconds: page.waitSeconds }),
  };
}

/**
 * A member cancelled the Run while a page ran: cancellation already stopped
 * the AI work it could see, so stop any this page admitted after it.
 */
async function lostAfterPage(
  db: Database,
  owner: RunRow,
): Promise<StepAdvance> {
  const now = await readStepRunOwner(db, owner.id);
  if (now?.status === "failed" && now.failureCode === "user_cancelled") {
    const { cancelRunAiWork } = await import("~/server/workflows/runs/control");
    await cancelRunAiWork(db, owner.id, "Cancelled by a member");
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
  counts: Omit<RunStepCounts, "found">,
  stamp: { attempt: number; sequence: number },
) {
  const failures = counts.failed ? ` · ${counts.failed} failed` : "";
  const total = denominatorOf(step);
  await recordRunProgress(
    db,
    owner.id,
    counts.failed ? "step_failed" : "step_finished",
    `${step.label}: ${counts.done} done${total === null ? "" : ` of ${total}`}${failures}`,
    stamp,
  );
}

/**
 * A budget or authorization pause stops the whole Run as `paused_auth` /
 * `execution_limit`, matching AI-work Runs; the Job resumes it once the
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
}

async function finishStepRun(
  db: Database,
  owner: RunRow,
  steps: readonly RunStepRow[],
  attempt: number,
) {
  const failed = steps.filter((step) => step.state === "failed");
  const worked = steps.some((step) => step.done + step.failed > 0);
  const finished = await finishStepRunRow(db, owner.id, attempt, {
    failedLabels: failed.map((step) => step.label),
    routine: owner.trigger === "scheduled" && !worked,
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
}

/**
 * "Retry failed" on one step: its failures become work again and the Run
 * relaunches from that step; earlier finished steps are not re-run.
 */
export async function retryRunStep(db: Database, runId: RunId, key: string) {
  const owner = await readStepRunOwner(db, runId);
  if (
    !owner ||
    !isStepRunPurpose(owner.purpose) ||
    !isExecutedRunPurpose(owner.purpose)
  )
    throw new Error("Only an executed step-ledger Run has steps to retry");
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
  await launchWorkflowRun(db, { runId, purpose: owner.purpose });
  return reopened;
}
