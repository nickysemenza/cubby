import { createLogger } from "@cubby/worker-tracing";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  withJobExecution,
  type JobExecutionDetails,
} from "~/server/generic/jobs/context";
import { JobSupersededError } from "~/server/generic/jobs/errors";
import { classifyJobFailure } from "~/server/generic/jobs/failure";
import { jobKindPolicy } from "~/server/generic/jobs/kind-policy";
import { JOB_DRAIN, JOB_HEARTBEAT_MS } from "~/server/generic/jobs/limits";
import {
  assertJobClaim,
  claimJob,
  dueJobs,
  fenceJob,
  failJob,
  fencedJobTransaction,
  pauseClaimedJob,
  publishJobPage,
  renewJob,
  type JobClaim,
} from "~/server/generic/jobs/repo/queue";

import type {
  JobContext,
  JobHandler,
  JobHandlers,
  PreparedJobPage,
} from "../types";

const log = createLogger("jobs");

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

/** Queue and cron call this same path; neither owns a second retry budget. */
export async function advanceJob(
  db: Database,
  id: string,
  handlers: JobHandlers,
): Promise<JobOutcome> {
  const claimed = await claimJob(db, id);
  if (!claimed) return "skipped";
  const handler = handlers[claimed.kind];
  return executeClaim(db, claimed, (context) => {
    if (!handler)
      throw new Error(`No job handler registered for ${claimed.kind}`);
    return handler.prepare(db, claimed, context);
  });
}

/** Heartbeat, fences, publication and the one failure classification for every page. */
async function executeClaim(
  db: Database,
  claimed: JobClaim,
  prepare: (context: JobContext) => Promise<PreparedJobPage>,
): Promise<JobOutcome> {
  const details: JobExecutionDetails = { stepKey: null };
  let publicationStartedAt: number | undefined;
  let publicationDurationMs: number | undefined;
  const entry = () =>
    log.child({
      runId: claimed.runId,
      jobId: claimed.id,
      kind: claimed.kind,
      jobKey: claimed.key,
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
  let renewing: Promise<unknown> | undefined;
  const heartbeat = setInterval(() => {
    renewing ??= renewJob(db, claimed)
      .then((renewed) => {
        if (renewed) return entry().info("lease renewed");
        entry().warn("lease lost");
        lease.abort(new JobSupersededError());
      })
      .catch((error: unknown) =>
        entry().error("lease renewal failed", { error }),
      )
      .finally(() => {
        renewing = undefined;
      });
  }, JOB_HEARTBEAT_MS);
  const context = claimContext(db, claimed, lease.signal);
  try {
    const prepared = await withJobExecution(
      db,
      claimed,
      () => prepare(context),
      details,
    );
    entry().info("page", { waitReason: prepared.page.waitReason ?? null });
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
    });
    return published ? "succeeded" : "superseded";
  } catch (error) {
    const failure = classifyJobFailure(error);
    switch (failure.kind) {
      case "paused":
        await pauseClaimedJob(db, claimed, failure.error);
        return "paused";
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
        return "deferred";
      case "interrupted":
        // The token fence makes this a no-op once another claim owns the Job.
        await failJob(db, claimed, error);
        entry().warn("superseded", { error });
        return "superseded";
      default:
        await failJob(db, claimed, error);
        entry().error("fail", { error });
        return "failed";
    }
  } finally {
    clearInterval(heartbeat);
    await renewing;
  }
}

/**
 * Free lanes reselect fair work without waiting for a slow sibling. Selected
 * Jobs stay reserved locally until their page finishes; leases and kind
 * admission protect claims across independent drains.
 */
export async function drainDueJobs(
  db: Database,
  handlers: JobHandlers,
  limit = JOB_DRAIN.pageLimit,
  timeBudgetMs = JOB_DRAIN.timeBudgetMs,
  concurrency = JOB_DRAIN.concurrency,
) {
  const outcomes: JobOutcome[] = [];
  const deadline = Date.now() + timeBudgetMs;
  let scheduled = 0;
  let settled = 0;
  let progressed = 0;
  const reserved = new Set<string>();
  // Kind caps can outlast this invocation. A row lock may clear while a
  // sibling publishes, so reconsider uncapped refusals after real progress.
  const cappedSkips = new Set<string>();
  const busy = new Set<string>();
  const selected: Awaited<ReturnType<typeof dueJobs>> = [];
  let selecting: Promise<boolean> | undefined;
  let failure: { reason: unknown } | undefined;
  const spent = () =>
    failure !== undefined || scheduled >= limit || Date.now() >= deadline;
  const refill = async () => {
    const settledBefore = settled;
    const remaining = Math.min(
      JOB_DRAIN.batch,
      limit - scheduled - selected.length,
    );
    if (remaining <= 0) return false;
    const candidates = await dueJobs(db, remaining, {
      excludeIds: [...reserved, ...cappedSkips, ...busy],
    });
    for (const candidate of candidates) {
      reserved.add(candidate.id);
      selected.push(candidate);
    }
    // A page may finish while selection is in flight. Reselect before every
    // idle lane exits on an empty result from that older snapshot.
    return candidates.length > 0 || settledBefore !== settled;
  };
  const next = async () => {
    while (!spent()) {
      const candidate = selected.shift();
      if (candidate) {
        scheduled++;
        return candidate;
      }
      selecting ??= refill().finally(() => {
        selecting = undefined;
      });
      if (!(await selecting)) return undefined;
    }
    return undefined;
  };
  const lane = async () => {
    for (;;) {
      const candidate = await next();
      if (!candidate) return;
      const progressBefore = progressed;
      try {
        const outcome = await advanceJob(db, candidate.id, handlers);
        outcomes.push(outcome);
        if (outcome === "skipped") {
          if (jobKindPolicy(candidate.kind).maxInFlight !== undefined)
            cappedSkips.add(candidate.id);
          // A sibling may have progressed while this refusal was in flight.
          else if (progressBefore === progressed) busy.add(candidate.id);
        } else {
          progressed++;
          busy.clear();
        }
      } finally {
        reserved.delete(candidate.id);
        settled++;
      }
    }
  };
  // Invocation cleanup must not close clients while a sibling still owns work.
  // Stop new selection on an escaped error, join active lanes, then rethrow it.
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, limit)) }, () =>
      lane().catch((reason: unknown) => {
        failure ??= { reason };
      }),
    ),
  );
  if (failure) throw failure.reason;
  if ((await dueJobs(db, 1)).length) {
    await (
      await import("~/server/workflows/background-tasks/publish")
    ).wakeJobs({ source: "job.drain-budget" });
  }
  return outcomes;
}
