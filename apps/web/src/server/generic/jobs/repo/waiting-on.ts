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
  UNDRAINED_JOB_KINDS,
} from "~/server/generic/jobs/kind-policy";
import { dueJobPositions, type JobRow } from "~/server/generic/jobs/repo/jobs";

/** Lane throughput is measured over this window. */
export const LANE_THROUGHPUT_WINDOW_MS = 30 * 60_000;

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
 * CLI, MCP, Run rollups) reads. Pure: queue position, throughput and the
 * executor are loaded by `loadJobWaitingOn`. Terminal Jobs wait on nothing.
 */
export function deriveJobWaitingOn(
  job: WaitingFacts,
  context: {
    now: Date;
    aheadCount?: number;
    /** Claims per second the Job's queue (drain or device pulls) served recently. */
    claimsPerSecond?: number;
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
      ? waitingForDevice(context)
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
  if (lane === "apple_device") return waitingForDevice(context);
  return {
    reason: "due",
    lane,
    aheadCount: context.aheadCount ?? 0,
    etaSeconds: eta(context),
  };
}

const eta = (context: { aheadCount?: number; claimsPerSecond?: number }) =>
  context.claimsPerSecond && context.claimsPerSecond > 0
    ? Math.round(((context.aheadCount ?? 0) + 1) / context.claimsPerSecond)
    : null;

const waitingForDevice = (context: {
  aheadCount?: number;
  claimsPerSecond?: number;
}): JobWaitingOn => ({
  reason: "waiting_device",
  lane: "apple_device",
  aheadCount: context.aheadCount ?? 0,
  etaSeconds: eta(context),
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

/** Claims per second each queue served over the throughput window. */
async function queueThroughput(db: Database, now: Date) {
  const since = new Date(now.getTime() - LANE_THROUGHPUT_WINDOW_MS);
  const result = await repositoryQueries(db).execute<{
    kind: string;
    claims: number;
  }>(sql`SELECT kind, count(*)::int AS claims FROM "Job"
    WHERE "lastClaimedAt" > ${since.toISOString()}::timestamp GROUP BY kind`);
  let drained = 0;
  let device = 0;
  for (const row of result.rows) {
    if (UNDRAINED_JOB_KINDS.includes(row.kind)) device += row.claims;
    else drained += row.claims;
  }
  const seconds = LANE_THROUGHPUT_WINDOW_MS / 1000;
  return { drained: drained / seconds, device: device / seconds };
}

/**
 * Batched waiting-on for listed Jobs: one fair-order read for drain
 * positions, one for device-pull positions, one throughput read and one
 * executor read for leased image work.
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
  const ids = live.map((row) => row.id);
  const [throughput, drainAhead, deviceAhead, executors] = await Promise.all([
    live.length ? queueThroughput(db, now) : { drained: 0, device: 0 },
    positions(db, ids, "drain"),
    positions(db, ids, "device"),
    leasedExecutors(
      db,
      live.filter((row) => row.state === jobState.enum.running),
    ),
  ]);
  for (const row of jobs) {
    const device = UNDRAINED_JOB_KINDS.includes(row.kind);
    out.set(
      row.id,
      deriveJobWaitingOn(row, {
        now,
        aheadCount: (device ? deviceAhead : drainAhead).get(row.id) ?? 0,
        claimsPerSecond: device ? throughput.device : throughput.drained,
        executor: executors.get(row.id)?.name ?? defaultExecutor(row.kind),
        executorDeviceId: executors.get(row.id)?.deviceId ?? null,
      }),
    );
  }
  return out;
}

const defaultExecutor = (kind: string) =>
  jobKindPolicy(kind).drained ? "Cubby server" : null;

async function positions(
  db: Database,
  ids: readonly string[],
  queue: "drain" | "device",
): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  if (queue === "drain") return dueJobPositions(db, ids);
  const at = sql`${new Date().toISOString()}::timestamp`;
  const wanted = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // Device pulls claim parked work oldest-available first.
  const result = await repositoryQueries(db).execute<{
    id: string;
    ahead: number;
  }>(sql`WITH due AS (
      SELECT id, (row_number() OVER (ORDER BY "availableAt", key) - 1)::int AS ahead
      FROM "Job"
      WHERE ${inKinds(sql`kind`, UNDRAINED_JOB_KINDS)}
        AND ((state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}) AND "availableAt" <= ${at})
          OR (state = ${jobState.enum.running} AND "leaseExpiresAt" <= ${at}))
    ) SELECT id, ahead FROM due WHERE id IN (${wanted})`);
  return new Map(result.rows.map((row) => [row.id, row.ahead]));
}

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
