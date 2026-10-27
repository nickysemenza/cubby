import { createLogger } from "@cubby/worker-tracing";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { findPgError } from "~/server/errors/db-errors";
import {
  withJobExecution,
  withJobBatchExecution,
  type JobExecutionDetails,
} from "~/server/generic/jobs/context";
import {
  JobPausedError,
  JobDeferredError,
  JobSupersededError,
  JobTargetError,
} from "~/server/generic/jobs/errors";
import { jobKindPolicy } from "~/server/generic/jobs/kind-policy";
import {
  JOB_BATCH_CLAIM_SHARE,
  JOB_DRAIN,
  JOB_HEARTBEAT_MS,
} from "~/server/generic/jobs/limits";
import {
  claimJob,
  dueJobs,
  failJob,
  pauseClaimedJob,
  publishJobPage,
  publishCompletedJobPages,
  renewJob,
  releaseJobClaim,
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
  const claimed = await claimJob(db, id, undefined, {
    pageToken: crypto.randomUUID(),
  });
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
  { renewLease = true }: { renewLease?: boolean } = {},
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
  const heartbeat = renewLease
    ? setInterval(() => {
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
      }, JOB_HEARTBEAT_MS)
    : undefined;
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
    if (heartbeat !== undefined) clearInterval(heartbeat);
    await renewing;
  }
}

/** Claim and settle serially inside one lane: batch width never multiplies DB sockets. */
async function advanceBatch(
  db: Database,
  ids: readonly string[],
  batch: NonNullable<JobHandler["batch"]>,
  deadline: number,
  onSkipped: (id: string) => void,
) {
  const pageToken = crypto.randomUUID();
  const pending = new Map<string, JobClaim>();
  const outcomes: string[] = [];
  let renewing: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    renewing ??= (async () => {
      for (const claim of pending.values()) {
        try {
          const renewed = await renewJob(db, claim, { skipLocked: true });
          if (!renewed)
            log.warn("batch lease renewal refused", { jobId: claim.id });
        } catch (error) {
          // A failed or contended Job must not consume its siblings' renewal turn.
          log.error("batch lease renewal failed", { jobId: claim.id, error });
        }
      }
    })().finally(() => {
      renewing = undefined;
    });
  }, JOB_HEARTBEAT_MS);
  const checkpoint: Parameters<
    NonNullable<JobHandler["batch"]>["execute"]
  >[2]["checkpoint"] = async (results) => {
    const remaining = new Map(results);
    const groups = new Set(
      [...results.values()].flatMap((result) =>
        result.status === "fulfilled" && result.value.publicationGroup
          ? [result.value.publicationGroup]
          : [],
      ),
    );
    for (const group of groups) {
      const entries = [...results].flatMap(([id, result]) => {
        const claim = pending.get(id);
        if (!claim)
          throw new Error("Batch checkpoint included an unclaimed Job");
        return result.status === "fulfilled" &&
          result.value.publicationGroup === group
          ? [{ claim, page: result.value.page }]
          : [];
      });
      try {
        const publicationStartedAt = Date.now();
        const started = performance.now();
        const published = await publishCompletedJobPages(
          db,
          entries,
          group.publish,
        );
        for (const { claim } of entries) {
          log.info("publish", {
            runId: claim.runId,
            jobId: claim.id,
            kind: claim.kind,
            jobKey: claim.key,
            generation: claim.generation,
            attempt: claim.attempts,
            published: published.has(claim.id),
            done: true,
            waitReason: null,
            publicationStartedAt,
            publicationDurationMs: Math.round(performance.now() - started),
          });
          outcomes.push(published.has(claim.id) ? "succeeded" : "superseded");
          pending.delete(claim.id);
          remaining.delete(claim.id);
        }
      } catch (error) {
        // Data failures roll back the whole page before individual recovery.
        if (
          !(error instanceof JobTargetError) &&
          !(error instanceof JobSupersededError) &&
          !/^(22|23|54)/.test(findPgError(error)?.code ?? "")
        )
          throw error;
      }
    }
    for (const [id, result] of remaining) {
      const claim = pending.get(id);
      if (!claim) throw new Error("Batch checkpoint included an unclaimed Job");
      outcomes.push(
        await executeClaim(
          db,
          claim,
          async () => {
            if (result.status === "rejected") throw result.reason;
            return result.value;
          },
          { renewLease: false },
        ),
      );
      pending.delete(id);
    }
  };
  // Production regression: serial claims on a loaded database spent the whole
  // budget, so every page released its claims unexecuted. Claiming may use at
  // most this share of the remaining budget; execution keeps the rest.
  const claimDeadline =
    Date.now() + (deadline - Date.now()) * JOB_BATCH_CLAIM_SHARE;
  try {
    for (const id of ids) {
      if (Date.now() >= claimDeadline) break;
      const claim = await claimJob(db, id, undefined, { pageToken });
      if (claim) pending.set(claim.id, claim);
      else {
        outcomes.push("skipped");
        onSkipped(id);
      }
    }
    if (!pending.size || Date.now() >= deadline) return outcomes;
    try {
      await withJobBatchExecution(() =>
        batch.execute(db, [...pending.values()], { deadline, checkpoint }),
      );
      if (pending.size && Date.now() < deadline)
        throw new Error("Batch handler omitted a Job result");
    } catch (reason) {
      await checkpoint(
        new Map(
          [...pending.keys()].map((id) => [id, { status: "rejected", reason }]),
        ),
      );
    }
  } finally {
    clearInterval(heartbeat);
    await renewing;
    // Never leave unstarted work leased across a drain yield, or charge its
    // claim against the retry budget. Completed chunks have already committed.
    for (const claim of pending.values())
      outcomes.push(
        (await releaseJobClaim(db, claim)) ? "released" : "superseded",
      );
  }
  return outcomes;
}

/**
 * Free lanes reselect fair work without waiting for a slow sibling. Selected
 * groups stay reserved locally until execution finishes; live leases and
 * atomic kind admission protect claims across independent drains.
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
  let scheduled = 0;
  const reserved = new Set<string>();
  const skipped = new Set<string>();
  const activeServices = new Set<string>();
  const activePages = new Map<string, number>();
  const batchSizes = new Map(
    Object.entries(handlers).flatMap(([kind, handler]) =>
      handler.batch ? [[kind, handler.batch.size] as const] : [],
    ),
  );
  type Candidates = Awaited<ReturnType<typeof dueJobs>>;
  const groups: Candidates[] = [];
  let settledPages = 0;
  let selecting: Promise<boolean> | undefined;
  let failure: { reason: unknown } | undefined;
  const spent = () =>
    failure !== undefined || scheduled >= limit || Date.now() >= deadline;
  const refill = async () => {
    const settledBefore = settledPages;
    const groupsBefore = groups.length;
    const remaining =
      limit -
      scheduled -
      groups.reduce((total, group) => total + group.length, 0);
    if (remaining <= 0) return false;
    const excludeKinds = [...activePages].flatMap(([kind, active]) => {
      const cap = jobKindPolicy(kind).maxConcurrentPages;
      return cap !== undefined && active >= cap ? [kind] : [];
    });
    const candidates = await dueJobs(db, remaining, {
      excludeIds: [...reserved, ...skipped],
      excludeKinds,
      batchSizes,
    });
    // Keep the fair selector's first service for each kind. A kind batch owns
    // one of the same three lanes; it never fans out publication transactions.
    const batches = new Map<string, Candidates>();
    for (const candidate of candidates) {
      if (candidate.pageKey && activeServices.has(candidate.pageKey)) continue;
      reserved.add(candidate.id);
      const batch = handlers[candidate.kind]?.batch;
      const key = `${candidate.kind}:${candidate.runOwned}:${candidate.capExempt}`;
      const existing = batches.get(key);
      if (batch && existing && existing.length < batch.size)
        existing.push(candidate);
      else {
        const group = [candidate];
        groups.push(group);
        if (batch) batches.set(key, group);
      }
    }
    // A page may finish or skip while selection is in flight. Reselect before
    // every idle lane exits on an empty result from that older snapshot.
    return groups.length > groupsBefore || settledBefore !== settledPages;
  };
  const nextGroup = async () => {
    while (!spent()) {
      const available = (group: Candidates) => {
        const first = group[0]!;
        const cap = jobKindPolicy(first.kind).maxConcurrentPages;
        return (
          first.capExempt ||
          cap === undefined ||
          (activePages.get(first.kind) ?? 0) < cap
        );
      };
      const leading = groups.findIndex(
        (group) => group[0]!.runOwned && available(group),
      );
      const reservedPage = groups.findIndex((group) => {
        const first = group[0]!;
        return (
          available(group) &&
          (activePages.get(first.kind) ?? 0) <
            (jobKindPolicy(first.kind).reservedConcurrentPages ?? 0)
        );
      });
      const index =
        reservedPage >= 0
          ? reservedPage
          : leading >= 0
            ? leading
            : groups.findIndex(available);
      const group = index >= 0 ? groups.splice(index, 1)[0] : undefined;
      if (group) {
        scheduled += group.length;
        const first = group[0]!;
        activePages.set(first.kind, (activePages.get(first.kind) ?? 0) + 1);
        if (first.pageKey) activeServices.add(first.pageKey);
        return group;
      }
      // Share selection, not execution: an idle lane can refill while another
      // still prepares a page, without selecting its unclaimed batch members.
      selecting ??= refill().finally(() => {
        selecting = undefined;
      });
      if (!(await selecting)) return undefined;
    }
    return undefined;
  };
  const lane = async () => {
    for (;;) {
      const group = await nextGroup();
      if (!group) return;
      const candidate = group[0]!;
      const batch = handlers[candidate.kind]?.batch;
      try {
        const page = handlers[candidate.kind]?.advancePage;
        if (page && candidate.pageKey) {
          const outcome = await page(db, candidate.id);
          outcomes.push(outcome);
          if (outcome === "skipped") skipped.add(candidate.id);
        } else if (batch)
          outcomes.push(
            ...(await advanceBatch(
              db,
              group.map((entry) => entry.id),
              batch,
              deadline,
              (id) => skipped.add(id),
            )),
          );
        else {
          const outcome = await advanceJob(db, candidate.id, handlers);
          outcomes.push(outcome);
          // A lock can outlast this invocation. Do not spend every remaining
          // attempt selecting the same expired lease instead of healthy work.
          if (outcome === "skipped") skipped.add(candidate.id);
        }
      } finally {
        for (const entry of group) reserved.delete(entry.id);
        activePages.set(
          candidate.kind,
          (activePages.get(candidate.kind) ?? 1) - 1,
        );
        if (candidate.pageKey) activeServices.delete(candidate.pageKey);
        settledPages++;
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
