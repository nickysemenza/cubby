import { createLogger } from "@cubby/worker-tracing";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  withJobExecution,
  type JobExecutionDetails,
} from "~/server/generic/jobs/context";
import {
  JobPausedError,
  JobDeferredError,
  JobSupersededError,
} from "~/server/generic/jobs/errors";
import { JOB_DRAIN, JOB_HEARTBEAT_MS } from "~/server/generic/jobs/limits";
import {
  claimJob,
  dueJobs,
  failJob,
  pauseClaimedJob,
  publishJobPage,
  renewJob,
  type JobClaim,
} from "~/server/generic/jobs/repo/jobs";

import type { JobHandler, JobHandlers, PreparedJobPage } from "../types";
export {
  JobPausedError,
  JobDeferredError,
  JobSupersededError,
} from "~/server/generic/jobs/errors";

const log = createLogger("jobs");

/** Parse persisted input at the execution boundary, including after a deploy. */
export function defineJobHandler<S extends z.ZodType>(
  schema: S,
  prepare: (
    db: Database,
    claim: JobClaim,
    input: z.output<S>,
  ) => Promise<PreparedJobPage>,
): JobHandler {
  return {
    prepare: (db, claim) => prepare(db, claim, schema.parse(claim.input)),
  };
}

/** Queue and cron call this same path; neither owns a second retry budget. */
export async function advanceJob(
  db: Database,
  id: string,
  handlers: JobHandlers,
) {
  const claimed = await claimJob(db, id);
  if (!claimed) return "skipped";
  const details: JobExecutionDetails = { stepKey: null };
  const entry = () =>
    log.child({
      runId: claimed.runId,
      jobId: id,
      kind: claimed.kind,
      stepKey: details.stepKey,
      generation: claimed.generation,
      attempt: claimed.attempts,
      waitReason: null,
    });
  entry().info("claim");
  const handler = handlers[claimed.kind];
  let renewing: Promise<boolean> | undefined;
  const heartbeat = setInterval(() => {
    if (!renewing) {
      renewing = renewJob(db, claimed)
        .catch((error: unknown) => {
          entry().error("lease renewal failed", { error });
          return false;
        })
        .finally(() => {
          renewing = undefined;
        });
    }
  }, JOB_HEARTBEAT_MS);
  try {
    if (!handler)
      throw new Error(`No job handler registered for ${claimed.kind}`);
    const prepared = await withJobExecution(
      db,
      claimed,
      () => handler.prepare(db, claimed),
      details,
    );
    entry().info("page", {
      awaitExternal: Boolean(prepared.awaitExternal),
      waitReason: prepared.page.waitReason ?? null,
    });
    if (prepared.awaitExternal) return "dispatched";
    const published = await withJobExecution(
      db,
      claimed,
      () => publishJobPage(db, claimed, prepared.page, prepared.publish),
      details,
    );
    entry().info("publish", {
      published,
      done: prepared.page.done,
      waitReason: prepared.page.done
        ? null
        : (prepared.page.waitReason ?? null),
    });
    return published ? "succeeded" : "superseded";
  } catch (error) {
    const causes: unknown[] = [];
    let cause: unknown = error;
    while (cause instanceof Error && !causes.includes(cause)) {
      causes.push(cause);
      cause = cause.cause;
    }
    const paused = causes.find((entry) => entry instanceof JobPausedError);
    const deferred = causes.find((entry) => entry instanceof JobDeferredError);
    const superseded = causes.find(
      (entry) => entry instanceof JobSupersededError,
    );
    if (paused instanceof JobPausedError) {
      await pauseClaimedJob(db, claimed, paused);
      return "paused";
    }
    if (deferred instanceof JobDeferredError) {
      await publishJobPage(db, claimed, {
        done: false,
        ...(claimed.cursor === null ? {} : { cursor: claimed.cursor }),
        waitUntil: deferred.until,
        waitReason: deferred.reason,
      });
      entry().info("defer", {
        waitReason: deferred.reason,
        waitUntil: deferred.until,
      });
      return "deferred";
    }
    if (superseded instanceof JobSupersededError) {
      await failJob(db, claimed, error);
      return "superseded";
    }
    await failJob(db, claimed, error);
    entry().error("fail", { error });
    return "failed";
  } finally {
    clearInterval(heartbeat);
    await renewing;
  }
}

/** Reselect after each fair batch; a wake can advance multiple bounded pages. */
export async function drainDueJobs(
  db: Database,
  handlers: JobHandlers,
  limit = JOB_DRAIN.pageLimit,
  timeBudgetMs = JOB_DRAIN.timeBudgetMs,
) {
  const outcomes: string[] = [];
  const deadline = Date.now() + timeBudgetMs;
  while (outcomes.length < limit && Date.now() < deadline) {
    const candidates = await dueJobs(
      db,
      Math.min(JOB_DRAIN.batch, limit - outcomes.length),
    );
    if (!candidates.length) return outcomes;
    for (const candidate of candidates) {
      outcomes.push(await advanceJob(db, candidate.id, handlers));
      if (outcomes.length >= limit || Date.now() >= deadline) break;
    }
  }
  if ((await dueJobs(db, 1)).length) {
    await (
      await import("~/server/workflows/background-tasks/publish")
    ).wakeJobs({ source: "job.drain-budget" });
  }
  return outcomes;
}
