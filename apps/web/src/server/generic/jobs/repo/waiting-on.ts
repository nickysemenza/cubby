import {
  jobState,
  jobWaitReason,
  type JobLane,
  type JobWaitingOn,
  type JobWaitingOnReason,
} from "@cubby/schemas/job";
import { sql, type SQL } from "drizzle-orm";

import {
  JOB_KIND_POLICY,
  jobKindPolicy,
} from "~/server/generic/jobs/kind-policy";
import { type JobRow } from "~/server/generic/jobs/repo/queue";
import {
  classifyWaiting,
  classifyWaitingSql,
} from "~/server/generic/jobs/repo/waiting-classifier";

type WaitingFacts = Pick<
  JobRow,
  | "kind"
  | "state"
  | "runId"
  | "attempts"
  | "error"
  | "waitReason"
  | "availableAt"
  | "leaseExpiresAt"
  | "lastClaimedAt"
>;

/**
 * What one Job waits on — the single derivation every surface (web, Apple,
 * CLI, MCP, Run rollups) reads. Pure classification; executor details come
 * from `loadJobWaitingOn`. Terminal Jobs wait on nothing.
 */
function deriveJobWaitingOn(
  job: WaitingFacts,
  context: {
    now: Date;
    executor?: string | null;
    executorDeviceId?: string | null;
  },
): JobWaitingOn | null {
  const lane = jobKindPolicy(job.kind).lane;
  const at = (date: Date) => date.toISOString();
  switch (job.state) {
    case jobState.enum.completed:
    case jobState.enum.failed:
    case jobState.enum.cancelled:
      return null;
    case jobState.enum.paused:
      return { reason: "paused", lane, by: job.runId ? "run" : "member" };
  }
  const reason = classifyWaiting({
    leased: job.state === jobState.enum.running,
    waitReason: job.waitReason,
    later: job.availableAt.getTime() > context.now.getTime(),
    deviceLane: lane === "apple_device",
  });
  switch (reason) {
    case "leased":
      return {
        reason: "leased",
        lane,
        executor: context.executor ?? null,
        executorDeviceId: context.executorDeviceId ?? null,
        leasedAt: job.lastClaimedAt ? at(job.lastClaimedAt) : null,
        leaseExpiresAt: at(job.leaseExpiresAt ?? context.now),
        expired:
          !job.leaseExpiresAt ||
          job.leaseExpiresAt.getTime() <= context.now.getTime(),
      };
    case "waiting_funding":
      return { reason, lane, until: at(job.availableAt) };
    case "waiting_device":
      return waitingForDevice();
    case "blocked":
      return { reason, lane, by: "An Apple device preparing its input" };
    case "backing_off":
      return {
        reason,
        lane,
        until: at(job.availableAt),
        attempts: job.attempts,
        lastError: job.error,
        cause:
          job.waitReason === jobWaitReason.enum.rate_limit ||
          job.waitReason === jobWaitReason.enum.provider_capacity
            ? job.waitReason
            : null,
      };
    default:
      return { reason: "due", lane };
  }
}

const waitingForDevice = (): JobWaitingOn => ({
  reason: "waiting_device",
  lane: "apple_device",
});

const kindsOfLane = (lane: JobLane) =>
  Object.entries(JOB_KIND_POLICY)
    .filter(([, policy]) => policy.lane === lane)
    .map(([kind]) => kind);

const inKinds = (column: SQL, kinds: readonly string[]) =>
  kinds.length
    ? sql`${column} IN (${sql.join(
        kinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})`
    : sql`false`;

/**
 * The same classification in SQL, for aggregates over many Jobs (Run
 * rollups, lane counts). It mirrors `deriveJobWaitingOn` without the queue
 * position; `waiting-on.integration.test.ts` keeps the two in agreement.
 * Terminal Jobs classify as NULL.
 */
export const jobWaitingOnReasonSql = (
  table: { [K in "kind" | "state" | "waitReason" | "availableAt"]: SQL } = {
    kind: sql`"Job".kind`,
    state: sql`"Job".state`,
    waitReason: sql`"Job"."waitReason"`,
    availableAt: sql`"Job"."availableAt"`,
  },
  now = new Date(),
) => {
  const device = inKinds(table.kind, kindsOfLane("apple_device"));
  // Job timestamps are UTC without a zone; compare them to a UTC instant.
  const at = sql`${now.toISOString()}::timestamp`;
  const reason = classifyWaitingSql({
    leased: sql`${table.state} = ${jobState.enum.running}`,
    waitReason: table.waitReason,
    later: sql`${table.availableAt} > ${at}`,
    deviceLane: device,
  });
  return sql<JobWaitingOnReason | null>`(CASE
    WHEN ${table.state} IN (${jobState.enum.completed}, ${jobState.enum.failed}, ${jobState.enum.cancelled}) THEN NULL
    WHEN ${table.state} = ${jobState.enum.paused} THEN ${"paused"}
    ELSE ${reason} END)::text`;
};

/**
 * Waiting-on for listed Jobs. A lease handed off externally names its holder
 * (a device); Job ETA is intentionally not derived.
 */
export function loadJobWaitingOn(
  jobs: readonly JobRow[],
  now = new Date(),
): Map<string, JobWaitingOn | null> {
  const out = new Map<string, JobWaitingOn | null>();
  for (const row of jobs) {
    out.set(
      row.id,
      deriveJobWaitingOn(row, {
        now,
        executor: "Cubby server",
        executorDeviceId: null,
      }),
    );
  }
  return out;
}
