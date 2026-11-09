import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import { getWorkerVersion } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  withJobExecution,
  type JobExecutionDetails,
} from "~/server/generic/jobs/context";
import { classifyJobFailure } from "~/server/generic/jobs/failure";
import { withExecutionMetrics } from "~/server/generic/jobs/page-work";
import {
  assertJobClaim,
  claimJob,
  fenceJob,
  failJob,
  fencedJobTransaction,
  pauseClaimedJob,
  publishJobPage,
  recordJobExecution,
  type JobClaim,
} from "~/server/generic/jobs/repo/queue";

import type {
  JobContext,
  JobHandler,
  JobHandlers,
  PreparedJobPage,
} from "../types";

const log = createLogger("jobs");

/** Only drain counts reach logs; another page result may hold refs or evidence. */
const loggedPageResult = z
  .object({
    processed: z.number(),
    published: z.number(),
    failed: z.number(),
    covered: z.number(),
  })
  .partial();

export type JobOutcome =
  | "skipped"
  | "succeeded"
  | "superseded"
  | "paused"
  | "deferred"
  | "failed";

/** Parse persisted input at the execution boundary, including after a deploy. */
export function defineJobHandler<S extends z.ZodType>(
  schema: S,
  prepare: (
    db: Database,
    claim: JobClaim,
    input: z.output<S>,
    context: JobContext,
  ) => Promise<PreparedJobPage>,
): JobHandler {
  return {
    prepare: (db, claim, context) =>
      prepare(db, claim, schema.parse(claim.input), context),
  };
}

/** The fences a claim lends its page; the executor and Job fixtures build it the same way. */
export function claimContext(
  db: Database,
  claim: JobClaim,
  signal: AbortSignal = new AbortController().signal,
): JobContext & { claim: JobClaim } {
  return {
    claim,
    signal,
    fenced: (work, options) =>
      fencedJobTransaction(db, claim, work, options?.isolationLevel),
    fence: (tx) => fenceJob(tx, claim),
    check: () => assertJobClaim(db, claim),
  };
}

/** Receives a failed execution's error and its Job kind (Sentry, in production). */
export type JobFailureReport = (error: UnparsedError, kind: string) => void;

/** Queue and cron call this same path; neither owns a second retry budget. */
export async function advanceJob(
  db: Database,
  id: string,
  handlers: JobHandlers,
  {
    report,
    onClaim,
  }: {
    report?: JobFailureReport;
    /** Runs once the claim is held, before any work (arms its lease recovery). */
    onClaim?: (claim: JobClaim) => Promise<void>;
  } = {},
): Promise<JobOutcome> {
  const claimed = await claimJob(db, id);
  if (!claimed) return "skipped";
  await onClaim?.(claimed);
  const handler = handlers[claimed.kind];
  return executeClaim(
    db,
    claimed,
    (context) => {
      if (!handler)
        throw new Error(`No job handler registered for ${claimed.kind}`);
      return handler.prepare(db, claimed, context);
    },
    report,
  );
}

/** One execution, recorded on its Job row whatever its outcome. */
async function executeClaim(
  db: Database,
  claimed: JobClaim,
  prepare: (context: JobContext) => Promise<PreparedJobPage>,
  report?: JobFailureReport,
): Promise<JobOutcome> {
  const details: JobExecutionDetails = { stepKey: null };
  return withExecutionMetrics(async (sample) => {
    const { outcome, failure } = await settleClaim(
      db,
      claimed,
      prepare,
      details,
    );
    if (failure && outcome === "failed") report?.(failure.error, claimed.kind);
    await recordJobExecution(
      db,
      {
        id: claimed.id,
        generation: claimed.generation,
        claimedAt: claimed.lastClaimedAt,
      },
      {
        outcome,
        errorClass: failure?.kind ?? null,
        ...sample(),
        aiCostUsd: details.aiCostUsd ?? null,
        workerVersion: getWorkerVersion(),
        finishedAt: new Date().toISOString(),
      },
    ).catch((error: unknown) =>
      log.error("execution record failed", { jobId: claimed.id, error }),
    );
    return outcome;
  });
}

/** Fixed lease, fences, publication and the one failure classification for every page. */
async function settleClaim(
  db: Database,
  claimed: JobClaim,
  prepare: (context: JobContext) => Promise<PreparedJobPage>,
  details: JobExecutionDetails,
): Promise<{
  outcome: JobOutcome;
  failure?: { kind: string; error: UnparsedError };
}> {
  let publicationStartedAt: number | undefined;
  let publicationDurationMs: number | undefined;
  const entry = () =>
    log.child({
      runId: claimed.runId,
      jobId: claimed.id,
      kind: claimed.kind,
      jobKey: claimed.key,
      dueLagMs: claimed.lastClaimedAt
        ? Math.max(
            0,
            claimed.lastClaimedAt.getTime() - claimed.availableAt.getTime(),
          )
        : null,
      publicationStartedAt,
      publicationDurationMs,
      stepKey: details.stepKey,
      phase: details.phase ?? null,
      phaseElapsedMs: details.phaseStartedAt
        ? Date.now() - details.phaseStartedAt
        : null,
      phaseMs: details.phaseMs ?? {},
      generation: claimed.generation,
      attempt: claimed.attempts,
      waitReason: null,
    });
  entry().info("claim");
  const lease = new AbortController();
  const context = claimContext(db, claimed, lease.signal);
  try {
    const prepared = await withJobExecution(
      db,
      claimed,
      () => prepare(context),
      details,
    );
    const pageResult =
      loggedPageResult.safeParse(prepared.page.result).data ?? null;
    entry().info("page", {
      waitReason: prepared.page.waitReason ?? null,
      pageResult,
    });
    // A drain publishes its chunks during prepare (`drain.publish` in `phaseMs`),
    // so this interval then covers little beyond settling the outer Job.
    publicationStartedAt = Date.now();
    const started = performance.now();
    const published = await withJobExecution(
      db,
      claimed,
      () =>
        publishJobPage(
          db,
          claimed,
          prepared.page,
          prepared.publish,
          prepared.isolationLevel,
        ),
      details,
    ).finally(() => {
      publicationDurationMs = Math.round(performance.now() - started);
    });
    entry().info("publish", {
      published,
      done: prepared.page.done,
      waitReason: prepared.page.done
        ? null
        : (prepared.page.waitReason ?? null),
      pageResult,
    });
    return { outcome: published ? "succeeded" : "superseded" };
  } catch (error) {
    const failure = classifyJobFailure(error);
    const failed = { kind: failure.kind, error };
    switch (failure.kind) {
      case "paused":
        await pauseClaimedJob(db, claimed, failure.error);
        return { outcome: "paused", failure: failed };
      case "deferred":
        // A cooperative wait keeps the checkpoint and spends no attempt.
        await publishJobPage(db, claimed, {
          done: false,
          ...(claimed.cursor === null ? {} : { cursor: claimed.cursor }),
          waitUntil: failure.until,
          waitReason: failure.reason,
        });
        entry().info("defer", {
          waitReason: failure.reason,
          waitUntil: failure.until,
        });
        return { outcome: "deferred", failure: failed };
      case "interrupted":
        // The token fence makes this a no-op once another claim owns the Job.
        await failJob(db, claimed, error);
        entry().warn("superseded", { error });
        return { outcome: "superseded", failure: failed };
      default:
        await failJob(db, claimed, error);
        entry().error("fail", { error });
        return { outcome: "failed", failure: failed };
    }
  }
}
