import { AsyncLocalStorage } from "node:async_hooks";

import type { RunId } from "@cubby/schemas/identifiers";
import { jobState, jobWaitReason } from "@cubby/schemas/job";
import {
  runPurpose,
  runStatus,
  STEP_RUN_PURPOSES,
} from "@cubby/schemas/run-fields";
import { and, eq, notInArray, sql } from "drizzle-orm";

import type { AiBudgetExhaustedError } from "~/server/ai/budget";
import type { Database } from "~/server/db";
import {
  unwrapDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { run } from "~/server/db/schema";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

const boundEvaluation = new AsyncLocalStorage<{
  runId: RunId;
  evaluation: { id: string; token: string };
}>();
/** One evaluation may execute for its owning Run without that Run being `running`. */
export const withRunEvaluation = <T>(
  runId: RunId,
  evaluation: { id: string; token: string },
  work: () => Promise<T>,
) => boundEvaluation.run({ runId, evaluation }, work);

/** The workload boundary receives the same scoped attempt fence as the metered transport. */
export const currentRunEvaluation = (runId: RunId) => {
  const bound = boundEvaluation.getStore();
  return bound?.runId === runId ? bound.evaluation : undefined;
};

/** Paid work belongs to a live Run that is running or executing a bound evaluation. */
export async function assertRunExecutable(db: Database, runId: RunId) {
  const [current] = await unwrapDb(db)
    .select({ status: run.status, retiredAt: run.retiredAt })
    .from(run)
    .where(and(eq(run.id, runId), notDeleted(run)))
    .limit(1);
  if (!current || current.retiredAt)
    throw new Error("Run is no longer available for paid work.");
  const evaluation = currentRunEvaluation(runId);
  const sharedExecutable =
    evaluation &&
    (await (
      await import("~/server/ai/repo/ai-evaluation-requests")
    ).evaluationIsExecutable(db, evaluation, runId));
  if (current.status !== "running" && !sharedExecutable)
    throw new Error("Run is no longer executable.");
  return current;
}

/** A budget stop survives a Worker stop before the driver catches its typed error. */
export async function pauseExecutionRun(
  db: Database,
  runId: RunId,
  message: string,
): Promise<void> {
  // Recovery resumes these purposes in a later window: AI work through
  // Job execution, agent imports and Mail discovery through
  // `resumeFundingPausedRuns` (run/service/ai-work.ts).
  const recoverable = sql`${run.purpose} IN (${runPurpose.enum.mail_reclassify}, ${runPurpose.enum.suggestion_sweep}, ${runPurpose.enum.mail_import}, ${runPurpose.enum.photo_inventory}, ${runPurpose.enum.mail_discovery})`;
  await unwrapDb(db)
    .update(run)
    .set({
      status: sql`CASE WHEN ${recoverable} THEN ${runStatus.enum.paused_auth} ELSE ${runStatus.enum.needs_review} END`,
      endedAt: sql`CASE WHEN ${recoverable} THEN NULL ELSE ${new Date().toISOString()}::timestamp END`,
      failureCode: "execution_limit",
      dispatchError: message,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(run.id, runId),
        eq(run.status, "running"),
        // A step-ledger Run (maintenance, Sweep) pauses through its engine:
        // the typed error reaches the step driver, which pauses the step at
        // the resume time and keeps the step's cursor. Ending it here would
        // take the Run away from its current Job page mid-step.
        notInArray(run.purpose, [...STEP_RUN_PURPOSES]),
        notDeleted(run),
      ),
    );
}

const RESUME_MARGIN_MS = 60_000;

/**
 * A budget or funding stop pauses its Run and schedules the resume just past
 * the window boundary, so the Run waits instead of failing.
 */
export async function pauseForFunding(
  db: Database,
  runId: RunId,
  error: AiBudgetExhaustedError,
) {
  await withTransactionDatabase(db, async (tx) => {
    await pauseExecutionRun(tx, runId, error.message);
    const until = new Date(
      Date.parse(error.status.windowEnd) + RESUME_MARGIN_MS,
    );
    // One resume per funding window: its handler resumes every paused Run.
    const key = `funding-resume:${error.status.windowEnd}`;
    await enqueueJob(tx, {
      key,
      kind: "run.funding-resume",
      input: { until: until.toISOString() },
      availableAt: until,
    });
    await unwrapDb(tx)
      .execute(sql`UPDATE "Job" SET "waitReason"=${jobWaitReason.enum.ai_funding_window}, "waitUntil"=${until.toISOString()}::timestamp
      WHERE key=${key} AND state=${jobState.enum.queued}`);
  });
}
