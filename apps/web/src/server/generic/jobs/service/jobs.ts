import { createLogger } from "@cubby/worker-tracing";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  withJobExecution,
  withJobBatchExecution,
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
  return executeClaim(db, claimed, () => {
    const handler = handlers[claimed.kind];
    if (!handler)
      throw new Error(`No job handler registered for ${claimed.kind}`);
    return handler.prepare(db, claimed);
  });
}

/** The same publication, diagnostics and failure policy serves single and batch pages. */
async function executeClaim(
  db: Database,
  claimed: JobClaim,
  prepare: () => Promise<PreparedJobPage>,
) {
  const id = claimed.id;
  const details: JobExecutionDetails = { stepKey: null };
  let publicationStartedAt: number | undefined;
  let publicationDurationMs: number | undefined;
  const entry = () =>
    log.child({
      runId: claimed.runId,
      jobId: id,
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
      lastUsefulProgressAtClaim: claimed.lastUsefulProgressAt,
      recoveryTimeoutMs: claimed.recoveryTimeoutMs,
      generation: claimed.generation,
      attempt: claimed.attempts,
      waitReason: null,
    });
  entry().info("claim");
  let renewing: Promise<boolean> | undefined;
  const heartbeat = setInterval(() => {
    if (!renewing) {
      renewing = renewJob(db, claimed)
        .then((renewed) => {
          if (!renewed) entry().warn("lease renewal refused");
          else entry().info("lease renewed");
          return renewed;
        })
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
    const prepared = await withJobExecution(db, claimed, prepare, details);
    entry().info("page", {
      awaitExternal: Boolean(prepared.awaitExternal),
      waitReason: prepared.page.waitReason ?? null,
    });
    if (prepared.awaitExternal) return "dispatched";
    publicationStartedAt = Date.now();
    const publicationStarted = performance.now();
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
      publicationDurationMs = Math.round(
        performance.now() - publicationStarted,
      );
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

/** Claim and settle serially inside one lane: batch width never multiplies DB sockets. */
async function advanceBatch(
  db: Database,
  ids: readonly string[],
  batch: NonNullable<JobHandler["batch"]>,
) {
  const claims: JobClaim[] = [];
  const outcomes: string[] = [];
  let renewing: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    renewing ??= (async () => {
      for (const claim of claims) await renewJob(db, claim);
    })()
      .catch((error: unknown) => {
        log.error("batch lease renewal failed", { error });
      })
      .finally(() => {
        renewing = undefined;
      });
  }, JOB_HEARTBEAT_MS);
  try {
    for (const id of ids) {
      const claim = await claimJob(db, id);
      if (claim) claims.push(claim);
      else outcomes.push("skipped");
    }
    if (!claims.length) return outcomes;
    let results: ReadonlyMap<string, PromiseSettledResult<PreparedJobPage>>;
    try {
      results = await withJobBatchExecution(() => batch.prepare(db, claims));
    } catch (reason) {
      results = new Map(
        claims.map((claim) => [claim.id, { status: "rejected", reason }]),
      );
    }
    for (const claim of claims) {
      outcomes.push(
        await executeClaim(db, claim, async () => {
          const result = results.get(claim.id);
          if (!result) throw new Error("Batch handler omitted a Job result");
          if (result.status === "rejected") throw result.reason;
          return result.value;
        }),
      );
    }
    return outcomes;
  } finally {
    clearInterval(heartbeat);
    await renewing;
  }
}

/**
 * Reselect after each fair batch; a wake can advance multiple bounded pages.
 * Distinct Jobs of one batch run up to `concurrency` at a time: every claim
 * is its own row lock and lease, so pages never share execution state.
 */
export async function drainDueJobs(
  db: Database,
  handlers: JobHandlers,
  limit = JOB_DRAIN.pageLimit,
  timeBudgetMs = JOB_DRAIN.timeBudgetMs,
  concurrency = JOB_DRAIN.concurrency,
) {
  const outcomes: string[] = [];
  const deadline = Date.now() + timeBudgetMs;
  const spent = () => outcomes.length >= limit || Date.now() >= deadline;
  while (!spent()) {
    let candidates = await dueJobs(
      db,
      Math.min(JOB_DRAIN.batch, limit - outcomes.length),
    );
    if (!candidates.length) return outcomes;
    const batchSize = Math.max(
      JOB_DRAIN.batch,
      ...candidates.map(
        (candidate) => handlers[candidate.kind]?.batch?.size ?? 1,
      ),
    );
    if (batchSize > JOB_DRAIN.batch)
      candidates = await dueJobs(
        db,
        Math.min(batchSize, limit - outcomes.length),
      );
    // Keep the fair selector's first service for each kind. A kind batch owns
    // one of the same three lanes; it never fans out publication transactions.
    const groups: (typeof candidates)[] = [];
    const batches = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const batch = handlers[candidate.kind]?.batch;
      const key = `${candidate.kind}:${candidate.runOwned}`;
      const existing = batches.get(key);
      if (batch && existing && existing.length < batch.size)
        existing.push(candidate);
      else {
        const group = [candidate];
        groups.push(group);
        if (batch) batches.set(key, group);
      }
    }
    let next = 0;
    const lane = async () => {
      while (next < groups.length && !spent()) {
        const group = groups[next++]!;
        const candidate = group[0]!;
        const batch = handlers[candidate.kind]?.batch;
        if (batch)
          outcomes.push(
            ...(await advanceBatch(
              db,
              group.map((entry) => entry.id),
              batch,
            )),
          );
        else outcomes.push(await advanceJob(db, candidate.id, handlers));
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(concurrency, groups.length)) },
        lane,
      ),
    );
  }
  if ((await dueJobs(db, 1)).length) {
    await (
      await import("~/server/workflows/background-tasks/publish")
    ).wakeJobs({ source: "job.drain-budget" });
  }
  return outcomes;
}
