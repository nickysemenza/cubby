import { jobState } from "@cubby/schemas/job";
import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm";

import type { QueueHealthSnapshot } from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { jobKindPolicy } from "~/server/generic/jobs/kind-policy";
import {
  jobDue,
  unobservedJobInvalidation,
} from "~/server/generic/jobs/repo/jobs";

/** Thresholds that raise a watchdog alert; each alert carries its raw numbers. */
export const QUEUE_ALERT_THRESHOLDS = {
  /** A drained kind's oldest due Job has waited this long. */
  oldestDueSeconds: 30 * 60,
  /** Due Jobs grew by this many since the previous measurement. */
  dueGrowth: 1_000,
  /** Expired leases a drained kind may hold before the drain reclaims them. */
  expiredLeases: 25,
  /** Parked device work may carry more: only device pulls reclaim it. */
  deviceExpiredLeases: 250,
} as const;

/** Claims are counted over this recent window for claims per minute. */
const CLAIM_WINDOW_MINUTES = 10;

/**
 * Per-kind queue health from Job rows: due count and oldest due age, recent
 * claims per minute, expired leases and queued count. `previous` supplies
 * due growth. `imageDisagreement` comes from the image domain's own count.
 */
export async function measureQueueHealth(
  db: Database,
  input: {
    previous: QueueHealthSnapshot | null;
    imageDisagreement: number;
    now?: Date;
  },
): Promise<QueueHealthSnapshot> {
  const now = input.now ?? new Date();
  const at = sql`${now.toISOString()}::timestamp`;
  // The drain's own predicate, so invalidation-woken Jobs count as due.
  const due = jobDue(now);
  const woken = unobservedJobInvalidation();
  // When each due Job became due: an unobserved capture wakes it at the
  // marker's write, an expired lease at its expiry.
  const dueSince = sql`(CASE
    WHEN ${woken} AND (${job.state} = ${jobState.enum.completed} OR ${job.availableAt} > ${at})
      THEN (SELECT ji."updatedAt" FROM "JobInvalidation" ji WHERE ji.key = "Job".key)
    WHEN ${job.state} = ${jobState.enum.running} THEN ${job.leaseExpiresAt}
    ELSE ${job.availableAt} END)`;
  const rows = await getDb(db)
    .select({
      kind: job.kind,
      due: sql<number>`count(*) FILTER (WHERE ${due})::int`,
      oldestDueSeconds: sql<
        number | null
      >`extract(epoch FROM ${at} - min(${dueSince}) FILTER (WHERE ${due}))::int`,
      recentClaims: sql<number>`count(*) FILTER (WHERE ${job.lastClaimedAt} > ${at} - ${CLAIM_WINDOW_MINUTES} * interval '1 minute')::int`,
      expiredLeases: sql<number>`count(*) FILTER (WHERE ${job.state} = ${jobState.enum.running} AND ${job.leaseExpiresAt} <= ${at})::int`,
      queued: sql<number>`count(*) FILTER (WHERE ${job.state} IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}))::int`,
    })
    .from(job)
    .where(
      sql`${job.state} IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}, ${jobState.enum.running})
        OR ${job.lastClaimedAt} > ${at} - ${CLAIM_WINDOW_MINUTES} * interval '1 minute'
        OR ${due}`,
    )
    .groupBy(job.kind)
    .orderBy(job.kind);
  const previousDue = new Map(
    (input.previous?.kinds ?? []).map((kind) => [kind.kind, kind.due]),
  );
  const kinds = rows.map((row) => {
    const prior = previousDue.get(row.kind);
    return {
      kind: row.kind,
      lane: jobKindPolicy(row.kind).lane,
      due: row.due,
      oldestDueSeconds: row.oldestDueSeconds,
      claimsPerMinute: row.recentClaims / CLAIM_WINDOW_MINUTES,
      dueGrowth: prior === undefined ? null : row.due - prior,
      expiredLeases: row.expiredLeases,
      queued: row.queued,
    };
  });
  return {
    measuredAt: now.toISOString(),
    kinds,
    imageDisagreement: input.imageDisagreement,
    alerts: queueAlerts(kinds, input.imageDisagreement),
  };
}

/** Pure thresholds over one measurement. */
export function queueAlerts(
  kinds: QueueHealthSnapshot["kinds"],
  imageDisagreement: number,
): QueueHealthSnapshot["alerts"] {
  const T = QUEUE_ALERT_THRESHOLDS;
  const alerts: QueueHealthSnapshot["alerts"] = [];
  for (const kind of kinds) {
    const policy = jobKindPolicy(kind.kind);
    if (
      policy.drained &&
      kind.oldestDueSeconds !== null &&
      kind.oldestDueSeconds >= T.oldestDueSeconds
    )
      alerts.push({
        kind: kind.kind,
        code: "oldest_due",
        evidence: `oldest due ${kind.oldestDueSeconds}s; ${kind.due} due; ${kind.claimsPerMinute} claims/min`,
      });
    if (policy.drained && kind.due > 0 && kind.claimsPerMinute === 0)
      alerts.push({
        kind: kind.kind,
        code: "no_claims",
        evidence: `${kind.due} due; 0 claims in ${CLAIM_WINDOW_MINUTES} min`,
      });
    if (kind.dueGrowth !== null && kind.dueGrowth >= T.dueGrowth)
      alerts.push({
        kind: kind.kind,
        code: "due_growth",
        evidence: `due grew by ${kind.dueGrowth} to ${kind.due}`,
      });
    if (
      kind.expiredLeases >=
      (policy.drained ? T.expiredLeases : T.deviceExpiredLeases)
    )
      alerts.push({
        kind: kind.kind,
        code: "expired_leases",
        evidence: `${kind.expiredLeases} expired leases`,
      });
    if (policy.maxQueued !== null && kind.queued > policy.maxQueued)
      alerts.push({
        kind: kind.kind,
        code: "over_capacity",
        evidence: `${kind.queued} queued; cap ${policy.maxQueued}`,
      });
  }
  if (imageDisagreement > 0)
    alerts.push({
      kind: null,
      code: "image_disagreement",
      evidence: `${imageDisagreement} open image jobs without a live execution after repair`,
    });
  return alerts;
}

/** Room a producer has under its kind's queued cap; null means uncapped. */
export async function jobKindAdmission(
  db: Database,
  kind: string,
): Promise<number | null> {
  const cap = jobKindPolicy(kind).maxQueued;
  if (cap === null) return null;
  const [row] = await getDb(db)
    .select({ queued: sql<number>`count(*)::int` })
    .from(job)
    .where(
      and(
        eq(job.kind, kind),
        inArray(job.state, [jobState.enum.queued, jobState.enum.retry_wait]),
      ),
    );
  return Math.max(0, cap - (row?.queued ?? 0));
}

/** Completed and cancelled Jobs older than this are pruned; failed ones stay. */
export const JOB_RETENTION_MS = 14 * 24 * 60 * 60_000;

/**
 * Kinds whose finished rows other work still reads: embedding cleanup
 * deletes remote vectors from finished `embedding.refresh` rows.
 */
const RETAINED_KINDS = ["embedding.refresh", "embedding.cleanup"];

/**
 * Delete one bounded batch of finished execution rows. Domain evidence
 * (image attempts, AI evaluations, Run history, audit) lives on its own
 * tables and is never touched here.
 */
export async function pruneFinishedJobs(
  db: Database,
  { limit, now = new Date() }: { limit: number; now?: Date },
): Promise<number> {
  const before = new Date(now.getTime() - JOB_RETENTION_MS);
  const doomed = getDb(db)
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        inArray(job.state, [jobState.enum.completed, jobState.enum.cancelled]),
        lt(job.updatedAt, before),
        notInArray(job.kind, RETAINED_KINDS),
        // An invalidated long-lived Job is woken through its own row.
        sql`NOT EXISTS (SELECT 1 FROM "JobInvalidation" m WHERE m.key = "Job".key)`,
      ),
    )
    .limit(limit);
  const deleted = await getDb(db)
    .delete(job)
    .where(inArray(job.id, doomed))
    .returning({ id: job.id });
  return deleted.length;
}
