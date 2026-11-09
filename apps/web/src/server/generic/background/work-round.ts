import { createLogger } from "@cubby/worker-tracing";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import type {
  BackgroundDrain,
  DrainPage,
} from "~/server/generic/background/drains";
import {
  BACKGROUND_RECHECK_MS,
  createBackgroundPageBudget,
  type BackgroundPageBudget,
} from "~/server/generic/background/page-budget";
import { JOB_DRAIN } from "~/server/generic/jobs/limits";
import {
  drainDueJobs,
  type JobOutcome,
} from "~/server/generic/jobs/service/jobs";
import type { JobHandlers } from "~/server/generic/jobs/types";

const log = createLogger("drains");

type BackgroundRound = {
  outcomes: JobOutcome[];
  more: boolean;
  nextAt: Date | null;
  afterDrain?: string;
  failures: UnparsedError[];
  statistics: ReturnType<BackgroundPageBudget["snapshot"]>;
};

/** Job and feature pages share capacity; the transport carries only a fair cursor. */
export async function runBackgroundRound(
  db: Database,
  handlers: JobHandlers,
  drains: readonly BackgroundDrain[],
  options: { limit?: number; timeBudgetMs?: number; afterDrain?: string } = {},
): Promise<BackgroundRound> {
  const deadline =
    Date.now() + (options.timeBudgetMs ?? JOB_DRAIN.timeBudgetMs);
  const budget = createBackgroundPageBudget({
    deadline,
    featuresPending: drains.length > 0,
  });
  const after = drains.findIndex((drain) => drain.name === options.afterDrain);
  const ordered = [...drains.slice(after + 1), ...drains.slice(0, after + 1)];
  const failures: UnparsedError[] = [];
  const pages: DrainPage[] = [];
  let outcomes: JobOutcome[] = [];
  let unvisited = false;
  let afterDrain = options.afterDrain;
  try {
    const jobs = drainDueJobs(
      db,
      handlers,
      options.limit ?? JOB_DRAIN.pageLimit,
      options.timeBudgetMs ?? JOB_DRAIN.timeBudgetMs,
      JOB_DRAIN.concurrency,
      { deadline, pageWork: budget.jobs },
    );
    const features = (async () => {
      try {
        // Preserve the rotated order across discovery I/O, without a parent permit.
        for (const [index, drain] of ordered.entries()) {
          if (Date.now() >= deadline) {
            unvisited = true;
            break;
          }
          let requested = false;
          let started = false;
          let needsFullTurn = false;
          try {
            pages.push(
              await drain.page(db, {
                deadline,
                runPage: (work) => {
                  requested = true;
                  return budget.feature(() => {
                    started = true;
                    return work();
                  });
                },
              }),
            );
          } catch (error) {
            failures.push(error);
            log.error("drain page failed", { drain: drain.name, error });
          } finally {
            // A late unadmitted page gets a full turn; an expired first turn yields.
            needsFullTurn = index > 0 && requested && !started;
            if (needsFullTurn) unvisited = true;
            else afterDrain = drain.name;
          }
          if (needsFullTurn) break;
        }
      } finally {
        budget.finishFeatures();
      }
    })();
    const [jobResult, featureResult] = await Promise.allSettled([
      jobs,
      features,
    ]);
    if (jobResult.status === "fulfilled") {
      outcomes = jobResult.value.outcomes;
      pages.push(jobResult.value);
    } else {
      failures.push(jobResult.reason);
      log.error("Job round failed", { error: jobResult.reason });
    }
    if (featureResult.status === "rejected")
      failures.push(featureResult.reason);
  } finally {
    // Closing this invocation cannot close a sibling's I/O or abandon its pages.
    await budget.close();
  }
  const statistics = budget.snapshot();
  const now = Date.now();
  const due = pages.flatMap((page) =>
    page.nextAt ? [page.nextAt.getTime()] : [],
  );
  if (statistics.retryAt) due.push(statistics.retryAt.getTime());
  due.sort((a, b) => a - b);
  const next = due[0];
  const ready =
    unvisited ||
    pages.some((page) => page.more) ||
    statistics.held > 0 ||
    failures.length > 0 ||
    (next !== undefined && next <= now);
  const progressed =
    outcomes.includes("succeeded") ||
    pages.some(
      (page) =>
        page.more || (page.processed ?? 0) > 0 || (page.settled ?? 0) > 0,
    );
  const more = ready && progressed && !failures.length;
  // Unvisited pages are demand, not progress. Avoid immediate no-progress wakes.
  const nextAt = more
    ? null
    : ready
      ? new Date(
          Math.min(
            ...due.filter((at) => at > now),
            now + BACKGROUND_RECHECK_MS,
          ),
        )
      : next === undefined
        ? null
        : new Date(next);
  log.info("background round", {
    admittedUnits: statistics.started,
    heldUnits: statistics.held,
    peakLocalPages: statistics.peakLocalPages,
    peakIsolatePages: statistics.peakIsolatePages,
    afterDrain,
    progressed,
  });
  return { outcomes, more, nextAt, afterDrain, failures, statistics };
}
