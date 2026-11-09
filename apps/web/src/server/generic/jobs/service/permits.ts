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
import type { PermitRecovery } from "@cubby/schemas/queue-messages";
import { createLogger } from "@cubby/worker-tracing";
import type { SQL } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import { getWorkerVersion } from "~/server/cf-env";
import type { Database } from "~/server/db";
import type {
  BackgroundDrain,
  DrainPage,
} from "~/server/generic/background/drains";
import { meterDrainAiCost } from "~/server/generic/jobs/context";
import { classifyJobFailure } from "~/server/generic/jobs/failure";
import { withExecutionMetrics } from "~/server/generic/jobs/page-work";
import {
  claimDrainUnit,
  dueUnits,
  jobLeaseLapsed,
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

type PermitPorts = {
  /**
   * Send one permit, due now (`null`) or delayed until `at`. A `recover`
   * permit names one claim and runs only if that claim still needs recovery.
   */
  send(
    at: Date | null,
    source: string,
    recover?: PermitRecovery,
  ): Promise<void>;
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
    const outcome = await advanceJob(db, candidate.id, handlers, {
      report: (error) => ports.captureException(error, candidate.unit),
      // A killed invocation's lease lapses unobserved. Only this held claim
      // arms a recovery, and it does nothing once the claim settled.
      onClaim: (claim) =>
        ports.send(
          new Date(claim.leaseExpiresAt.getTime() + 5_000),
          "job.lease-recovery",
          { kind: "job", id: claim.id, lease: claim.leaseToken },
        ),
    });
    return outcome !== "skipped";
  }
  const drain = drainFor(drains, candidate.unit);
  if (!drain) return false;
  await claimDrainUnit(db, candidate.unit);
  return withExecutionMetrics(async (sample) => {
    const record = (
      outcome: JobExecution["outcome"],
      errorClass: string | null,
      page?: DrainPage,
    ) =>
      recordJobExecution(
        db,
        { unit: candidate.unit },
        {
          outcome,
          errorClass,
          ...sample(),
          aiCostUsd: page?.aiCostUsd ?? null,
          workerVersion: getWorkerVersion(),
          ...(page && {
            items: {
              claimed: page.claimed,
              published: page.published ?? 0,
              failed: page.failed ?? 0,
            },
          }),
          finishedAt: new Date().toISOString(),
        },
      ).catch((error: unknown) =>
        log.error("execution record failed", { unit: candidate.unit, error }),
      );
    try {
      const { result, aiCostUsd } = await meterDrainAiCost(() =>
        drain.page(db, candidate.unit, (recover) =>
          ports.send(new Date(Date.now() + recover.afterMs), recover.source, {
            kind: "image",
            ids: recover.ids,
          }),
        ),
      );
      const page = { ...result, aiCostUsd: result.aiCostUsd ?? aiCostUsd };
      await record(
        page.outcome ?? (page.claimed ? "succeeded" : "skipped"),
        null,
        page,
      );
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

/**
 * A recovery permit runs only if the claim it names is still leased and that
 * lease lapsed; otherwise it exits without running work or sending anything.
 */
export async function runRecovery(
  runtime: PermitRuntime,
  recover: PermitRecovery,
): Promise<string | null> {
  const { db, drains } = runtime;
  let candidate: DueUnit | null = null;
  if (recover.kind === "job") {
    if (await jobLeaseLapsed(db, recover.id, recover.lease))
      candidate = {
        type: "job",
        id: recover.id,
        unit: "job.lease-recovery",
        runOwned: false,
      };
  } else {
    const drain = drains.find((entry) => entry.recovers);
    if (drain?.recovers && (await drain.recovers(db, recover.ids)))
      candidate = { type: "drain", unit: drain.name, runOwned: false };
  }
  if (!candidate || !(await runUnit(runtime, candidate))) return null;
  await sendSuccessor(runtime, "permit.successor");
  return candidate.unit;
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
