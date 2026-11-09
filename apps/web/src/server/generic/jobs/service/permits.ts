/**
 * The background permit (docs/jobs.md#selection-and-admission): each queue
 * message lets one invocation claim ONE unit, either one Job page or one page
 * of a named drain. Selection is one SQL statement; the queue's
 * `max_concurrency` is the only concurrency bound. A permit that ran a unit
 * sends exactly one successor when anything is owed; a permit that found
 * nothing exits after that one query and sends nothing, so wake chains end
 * when the household goes idle.
 */
import type { JobExecution } from "@cubby/schemas/job";
import { createLogger } from "@cubby/worker-tracing";
import type { SQL } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import { getWorkerVersion } from "~/server/cf-env";
import type { Database } from "~/server/db";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import { classifyJobFailure } from "~/server/generic/jobs/failure";
import { withExecutionMetrics } from "~/server/generic/jobs/page-work";
import {
  claimDrainUnit,
  dueUnits,
  JOB_LEASE_MS,
  nextDueAt,
  recordJobExecution,
  type DueUnit,
} from "~/server/generic/jobs/repo/queue";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import type { JobHandlers } from "~/server/generic/jobs/types";

const log = createLogger("permits");

/** Candidates one permit may try when siblings took its first choices. */
const CANDIDATES = 8;
/** Cloudflare Queues' longest delivery delay; later work is the hourly cron's. */
const MAX_PERMIT_DELAY_MS = 12 * 60 * 60_000;

export type PermitPorts = {
  /** Send one permit, due now (`null`) or delayed until `at`. */
  send(at: Date | null, source: string): Promise<void>;
  captureException(error: UnparsedError, unit: string): void;
};

export type PermitRuntime = {
  db: Database;
  handlers: JobHandlers;
  drains: readonly BackgroundDrain[];
  ports: PermitPorts;
};

const drainFor = (drains: readonly BackgroundDrain[], unit: string) =>
  drains.find(
    (drain) => drain.name === unit || unit.startsWith(`${drain.name}:`),
  );

const fragments = (
  drains: readonly BackgroundDrain[],
  part: "due" | "next",
): SQL[] => drains.flatMap((drain) => drain[part]() ?? []);

/** Whether the unit claimed work; an unclaimed unit is a sibling's or nobody's. */
async function runUnit(
  runtime: PermitRuntime,
  candidate: DueUnit,
): Promise<boolean> {
  const { db, handlers, drains, ports } = runtime;
  if (candidate.type === "job") {
    // A killed invocation's lease lapses unobserved; this permit recovers it.
    await ports.send(
      new Date(Date.now() + JOB_LEASE_MS + 5_000),
      "job.lease-recovery",
    );
    const outcome = await advanceJob(db, candidate.id, handlers, (error) =>
      ports.captureException(error, candidate.unit),
    );
    return outcome !== "skipped";
  }
  const drain = drainFor(drains, candidate.unit);
  if (!drain) return false;
  await claimDrainUnit(db, candidate.unit);
  return withExecutionMetrics(async (sample) => {
    const record = (
      outcome: JobExecution["outcome"],
      errorClass: string | null,
      items?: JobExecution["items"],
    ) =>
      recordJobExecution(
        db,
        { unit: candidate.unit },
        {
          outcome,
          errorClass,
          ...sample(),
          aiCostUsd: null,
          workerVersion: getWorkerVersion(),
          ...(items && { items }),
          finishedAt: new Date().toISOString(),
        },
      ).catch((error: unknown) =>
        log.error("execution record failed", { unit: candidate.unit, error }),
      );
    try {
      const page = await drain.page(db, candidate.unit);
      await record(page.claimed ? "succeeded" : "skipped", null, {
        claimed: page.claimed,
        published: page.published ?? 0,
        failed: page.failed ?? 0,
      });
      return page.claimed > 0;
    } catch (error) {
      // Item state, backoff and waits live on the drain's rows. A failed page
      // sends no successor: a persistent failure must not loop; the unit's
      // record row moves it back in rotation for other permits and the cron.
      log.error("drain page failed", { unit: candidate.unit, error });
      ports.captureException(error, candidate.unit);
      await record("failed", classifyJobFailure(error).kind);
      return false;
    }
  });
}

/** Run the first claimable candidate; null when nothing was claimable. */
export async function runPermit(
  runtime: PermitRuntime,
  { successor = true }: { successor?: boolean } = {},
): Promise<string | null> {
  const { db, drains } = runtime;
  for (const candidate of await dueUnits(
    db,
    fragments(drains, "due"),
    CANDIDATES,
  )) {
    if (!(await runUnit(runtime, candidate))) continue;
    if (successor) await sendSuccessor(runtime, "permit.successor");
    return candidate.unit;
  }
  return null;
}

/**
 * A permit for the earliest owed work: now, delayed, or left to the cron.
 * `parallel` permits are sent only for work due now.
 */
export async function sendSuccessor(
  { db, drains, ports }: PermitRuntime,
  source: string,
  parallel = 1,
) {
  const at = await nextDueAt(db, fragments(drains, "next"));
  if (!at) return;
  const delay = at.getTime() - Date.now();
  if (delay > MAX_PERMIT_DELAY_MS) return;
  if (delay > 0) return ports.send(at, source);
  for (let index = 0; index < parallel; index++) await ports.send(null, source);
}
