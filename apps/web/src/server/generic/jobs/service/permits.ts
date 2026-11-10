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
  ArmDrainRecovery,
  BackgroundDrain,
  DrainPage,
} from "~/server/generic/background/drains";
import { type DrainMeter, meterDrainPage } from "~/server/generic/jobs/context";
import { classifyJobFailure } from "~/server/generic/jobs/failure";
import { withExecutionMetrics } from "~/server/generic/jobs/page-work";
import {
  claimDrainUnit,
  dueUnits,
  jobLeaseLapsed,
  nextDueAt,
  recordJobExecution,
  type DrainDue,
  type DueUnit,
} from "~/server/generic/jobs/repo/queue";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import type { JobHandlers } from "~/server/generic/jobs/types";
import { annotateActiveSpan } from "~/server/observability/tracing";

const log = createLogger("permits");

/**
 * Name the claimed unit before any work: an invocation killed for exceeding
 * memory writes no execution record, so this log line and span attribute are
 * what join its outcome to a unit in Workers telemetry.
 */
function claimed(fields: {
  unit: string;
  kind: string;
  jobId?: string;
  key?: string;
  runId?: string | null;
  generation?: number;
  recovery?: boolean;
}) {
  annotateActiveSpan({
    "cubby.background.unit": fields.unit,
    "cubby.background.kind": fields.kind,
    ...(fields.jobId && { "cubby.job.id": fields.jobId }),
    ...(fields.runId && { "cubby.run.id": fields.runId }),
  });
  // `key` stays out of the log: Job keys are free-form and could one day name
  // household data; the Job id joins to the row.
  const { key: _key, ...logged } = fields;
  log.info("permit claimed", logged);
}

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

/** Every drain's due rows, each tagged with the drain that will run them. */
const dueDrains = (drains: readonly BackgroundDrain[]): DrainDue[] =>
  drains.flatMap((drain) => {
    const due = drain.due();
    return due ? [{ name: drain.name, due }] : [];
  });

const nextFragments = (drains: readonly BackgroundDrain[]): SQL[] =>
  drains.flatMap((drain) => drain.next() ?? []);

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
      onClaim: (claim) => {
        claimed({
          unit: candidate.unit,
          kind: claim.kind,
          jobId: claim.id,
          key: claim.key,
          runId: claim.runId,
          generation: claim.generation,
        });
        return ports.send(
          new Date(claim.leaseExpiresAt.getTime() + 5_000),
          "job.lease-recovery",
          { kind: "job", id: claim.id, lease: claim.leaseToken },
        );
      },
    });
    return outcome !== "skipped";
  }
  // Selection tags each unit with the drain that reported it, so a unit can
  // never be left without a page. A miss means selection and this runtime
  // disagree about the registered drains: fail the permit, never drop the work.
  const drain = drains.find((entry) => entry.name === candidate.drain);
  if (!drain)
    throw new Error(
      `Drain unit ${candidate.unit} names unregistered drain ${candidate.drain}`,
    );
  return runDrainPage(runtime, candidate.unit, (armRecovery) =>
    drain.page(db, candidate.unit, armRecovery),
  );
}

/**
 * One drain page under a meter the permit owns, so its execution record keeps
 * the AI cost and committed item counts even when the page throws.
 */
async function runDrainPage(
  { db, ports }: PermitRuntime,
  unit: string,
  page: (armRecovery: ArmDrainRecovery) => Promise<DrainPage>,
  { recovery = false } = {},
): Promise<boolean> {
  // A recovery leaves the unit's rotation alone, and one that reclaimed
  // nothing leaves the unit's record as its last real page wrote it.
  if (!recovery) await claimDrainUnit(db, unit);
  claimed({ unit, kind: "background.drain", recovery });
  const meter: DrainMeter = {
    aiCostUsd: 0,
    claimed: 0,
    published: 0,
    failed: 0,
  };
  return withExecutionMetrics(async (sample) => {
    const record = (
      outcome: JobExecution["outcome"],
      errorClass: string | null,
      claimed: number,
      error?: UnparsedError,
    ) =>
      recordJobExecution(
        db,
        { unit, error },
        {
          outcome,
          errorClass,
          ...sample(),
          aiCostUsd: meter.aiCostUsd || null,
          workerVersion: getWorkerVersion(),
          ...((claimed || meter.published || meter.failed) && {
            items: {
              claimed,
              published: meter.published,
              failed: meter.failed,
            },
          }),
          finishedAt: new Date().toISOString(),
        },
      ).catch((error: unknown) =>
        log.error("execution record failed", { unit, error }),
      );
    try {
      const result = await meterDrainPage(meter, () =>
        page((claim) =>
          ports.send(
            new Date(claim.leaseExpiresAt.getTime() + 5_000),
            claim.source,
            { kind: "image", id: claim.id, attempt: claim.attempt },
          ),
        ),
      );
      const claimed = Math.max(result.claimed, meter.claimed);
      if (recovery && !claimed) return false;
      await record(
        result.outcome ?? (claimed ? "succeeded" : "skipped"),
        null,
        claimed,
      );
      return result.claimed > 0;
    } catch (error) {
      // Item state, backoff and waits live on the drain's rows. A failed page
      // sends no successor: a persistent failure must not loop; the unit's
      // record row moves it back in rotation for other permits and the cron.
      log.error("drain page failed", { unit, error });
      ports.captureException(error, unit);
      await record(
        "failed",
        classifyJobFailure(error).kind,
        meter.claimed,
        error,
      );
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
    // The reclaim itself is the check: overlapping recoveries for one attempt
    // cannot both claim it, and the loser runs nothing and sends nothing.
    const drain = drains.find((entry) => entry.recover);
    if (
      drain?.recover &&
      (await runDrainPage(
        runtime,
        drain.name,
        (armRecovery) => drain.recover!(db, recover, armRecovery),
        { recovery: true },
      ))
    ) {
      await sendSuccessor(runtime, "permit.successor");
      return drain.name;
    }
    return null;
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
  for (const candidate of await dueUnits(db, dueDrains(drains), CANDIDATES)) {
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
  const at = await nextDueAt(db, nextFragments(drains));
  if (!at) return;
  const delay = at.getTime() - Date.now();
  if (delay > MAX_PERMIT_DELAY_MS) return;
  if (delay > 0) return ports.send(at, source);
  for (let index = 0; index < parallel; index++) await ports.send(null, source);
}
