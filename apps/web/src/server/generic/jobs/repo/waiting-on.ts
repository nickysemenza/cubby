import {
  jobState,
  jobWaitingOnReason,
  jobWaitReason,
  type JobLane,
  type JobWaitingOn,
  type JobWaitingOnReason,
} from "@cubby/schemas/job";
import { sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  JOB_KIND_POLICY,
  jobKindPolicy,
} from "~/server/generic/jobs/kind-policy";
import { type JobRow } from "~/server/generic/jobs/repo/queue";

type WaitingFacts = Pick<
  JobRow,
  | "kind"
  | "state"
  | "runId"
  | "attempts"
  | "error"
  | "waitReason"
  | "waitUntil"
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
    case jobState.enum.running:
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
  }
  if (job.waitReason === jobWaitReason.enum.ai_funding_window)
    return {
      reason: "waiting_funding",
      lane,
      until: job.waitUntil ? at(job.waitUntil) : null,
    };
  const later = job.availableAt.getTime() > context.now.getTime();
  if (job.waitReason === jobWaitReason.enum.device && later)
    return lane === "apple_device"
      ? waitingForDevice()
      : { reason: "blocked", lane, by: "An Apple device preparing its input" };
  if (later)
    return {
      reason: "backing_off",
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
  if (lane === "apple_device") return waitingForDevice();
  return { reason: "due", lane };
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
  const R = jobWaitingOnReason.enum;
  return sql<JobWaitingOnReason | null>`(CASE
    WHEN ${table.state} IN (${jobState.enum.completed}, ${jobState.enum.failed}, ${jobState.enum.cancelled}) THEN NULL
    WHEN ${table.state} = ${jobState.enum.paused} THEN ${R.paused}
    WHEN ${table.state} = ${jobState.enum.running} THEN ${R.leased}
    WHEN ${table.waitReason} = ${jobWaitReason.enum.ai_funding_window} THEN ${R.waiting_funding}
    WHEN ${table.waitReason} = ${jobWaitReason.enum.device} AND ${table.availableAt} > ${at}
      THEN CASE WHEN ${device} THEN ${R.waiting_device} ELSE ${R.blocked} END
    WHEN ${table.availableAt} > ${at} THEN ${R.backing_off}
    WHEN ${device} THEN ${R.waiting_device}
    ELSE ${R.due} END)::text`;
};

/**
 * Batched waiting-on for listed Jobs. Leased image work includes the executor
 * assigned to its active attempt; Job ETA is intentionally not derived.
 */
export async function loadJobWaitingOn(
  db: Database,
  jobs: readonly JobRow[],
  now = new Date(),
): Promise<Map<string, JobWaitingOn | null>> {
  const out = new Map<string, JobWaitingOn | null>();
  if (!jobs.length) return out;
  const live = jobs.filter(
    (row) =>
      row.state === jobState.enum.queued ||
      row.state === jobState.enum.retry_wait ||
      row.state === jobState.enum.running,
  );
  const executors = await leasedExecutors(
    db,
    live.filter((row) => row.state === jobState.enum.running),
  );
  for (const row of jobs) {
    out.set(
      row.id,
      deriveJobWaitingOn(row, {
        now,
        executor: executors.get(row.id)?.name ?? defaultExecutor(row.kind),
        executorDeviceId: executors.get(row.id)?.deviceId ?? null,
      }),
    );
  }
  return out;
}

const defaultExecutor = (kind: string) =>
  jobKindPolicy(kind).drained ? "Cubby server" : null;

/** The executor assigned to a leased image attempt (the lease token is its id). */
async function leasedExecutors(
  db: Database,
  running: readonly JobRow[],
): Promise<
  Map<string, { name: string | null; deviceId: string | null } | null>
> {
  const tokens = running.flatMap((row) =>
    row.leaseToken && row.key.startsWith("image-processing:")
      ? [{ id: row.id, token: row.leaseToken }]
      : [],
  );
  if (!tokens.length) return new Map();
  const result = await repositoryQueries(db).execute<{
    id: string;
    name: string | null;
    deviceId: string | null;
  }>(sql`SELECT a.id::text AS id, a.executor->>${"name"} AS name,
      a.executor->>${"deviceId"} AS "deviceId"
    FROM "ImageProcessingAttempt" a
    WHERE a.id IN (${sql.join(
      tokens.map((entry) => sql`${entry.token}::uuid`),
      sql`, `,
    )})`);
  const byToken = new Map(result.rows.map((row) => [row.id, row]));
  return new Map(
    tokens.map((entry) => [entry.id, byToken.get(entry.token) ?? null]),
  );
}
