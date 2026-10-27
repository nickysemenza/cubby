import { jobState } from "@cubby/schemas/job";
import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm";

import type { QueueHealthSnapshot } from "~/contracts/job.contract";
import type { Database } from "~/server/db";
import { entityIdentity } from "~/server/db/entity-identity-schema";
import { getDb, withTransaction } from "~/server/db/helpers";
import { outer, related } from "~/server/db/helpers/related";
import { job, jobInvalidationCapture } from "~/server/db/retained-tables";
import { jobKindPolicy } from "~/server/generic/jobs/kind-policy";
import {
  jobDue,
  unobservedJobInvalidation,
} from "~/server/generic/jobs/repo/queue";

/** Thresholds that raise a watchdog alert; each alert carries its raw numbers. */
const QUEUE_ALERT_THRESHOLDS = {
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
  const restartingWoken = unobservedJobInvalidation({ restartsPass: true });
  // When each due Job became due, matching how `jobDue` wakes it: an
  // unobserved capture dates it from the first pending input (later
  // captures keep that start), an expired
  // lease at its expiry. A capture wakes a completed Job, or waiting work
  // under a restarting marker. Waiting work that has not started its pass
  // takes the earlier of the capture and its availability: the periodic
  // catch-up requeues with availability "now" without serving the capture.
  // A pass in progress that keeps its cursor is served on its availability,
  // and a capture it ran through dates its follow-up pass from completion
  // (a finished Job is due since the later of the two).
  const unobservedSince = related(
    jobInvalidationCapture,
    (c) => sql`${c.key} = ${outer(job.key)} AND NOT ${c.observed}`,
  ).min<Date>((c) => c.capturedAt);
  const waiting = sql`${job.state} IN (${jobState.enum.queued}, ${jobState.enum.retry_wait})`;
  const dueSince = sql`(CASE
    WHEN ${job.state} = ${jobState.enum.completed} AND ${woken}
      THEN greatest(${unobservedSince}, ${job.updatedAt})
    WHEN ${job.state} = ${jobState.enum.failed} AND ${restartingWoken} THEN ${unobservedSince}
    WHEN ${job.state} = ${jobState.enum.running} THEN ${job.leaseExpiresAt}
    WHEN ${waiting} AND ${restartingWoken} AND ${job.availableAt} > ${at}
      THEN ${unobservedSince}
    WHEN ${waiting} AND (${restartingWoken} OR (${job.cursor} IS NULL AND ${woken}))
      THEN least(${unobservedSince}, ${job.availableAt})
    ELSE ${job.availableAt} END)`;
  const windowStart = sql`${at} - ${CLAIM_WINDOW_MINUTES} * interval '1 minute'`;
  const rows = await getDb(db)
    .select({
      kind: job.kind,
      due: sql<number>`count(*) FILTER (WHERE ${due})::int`,
      oldestDueSeconds: sql<
        number | null
      >`extract(epoch FROM ${at} - min(${dueSince}) FILTER (WHERE ${due}))::int`,
      // Still due though due since before the window: no claim served it.
      unclaimedDue: sql<number>`count(*) FILTER (WHERE ${due} AND ${dueSince} <= ${windowStart})::int`,
      recentClaims: sql<number>`count(*) FILTER (WHERE ${job.lastClaimedAt} > ${windowStart})::int`,
      expiredLeases: sql<number>`count(*) FILTER (WHERE ${job.state} = ${jobState.enum.running} AND ${job.leaseExpiresAt} <= ${at})::int`,
      queued: sql<number>`count(*) FILTER (WHERE ${job.state} IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}))::int`,
    })
    .from(job)
    .where(
      sql`${job.state} IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}, ${jobState.enum.running})
        OR ${job.lastClaimedAt} > ${windowStart}
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
      unclaimedDue: row.unclaimedDue,
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
function queueAlerts(
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
    // Claims of one Job do not cover another: a Job unserved for the whole
    // window while the kind's claims could have served every due Job was
    // passed over, not queued behind a backlog.
    const claims = kind.claimsPerMinute * CLAIM_WINDOW_MINUTES;
    if (
      policy.drained &&
      kind.due > 0 &&
      (claims === 0 || (kind.unclaimedDue > 0 && claims >= kind.due))
    )
      alerts.push({
        kind: kind.kind,
        code: "no_claims",
        evidence: `${kind.due} due; ${kind.unclaimedDue} unclaimed for ${CLAIM_WINDOW_MINUTES} min; ${claims} claims in ${CLAIM_WINDOW_MINUTES} min`,
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
  return withTransaction(db, async (tx) => {
    const doomed = tx
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          inArray(job.state, [
            jobState.enum.completed,
            jobState.enum.cancelled,
          ]),
          lt(job.updatedAt, before),
          notInArray(job.kind, RETAINED_KINDS),
          // An invalidated long-lived Job is woken through its own row.
          sql`NOT EXISTS (SELECT 1 FROM "JobInvalidation" m WHERE m.key = "Job".key)`,
        ),
      )
      .limit(limit)
      .for("update", { skipLocked: true });
    const deleted = await tx
      .delete(job)
      .where(inArray(job.id, doomed))
      .returning({ id: job.id });
    // Job is the sole expiring entity: pruning execution also releases its code.
    if (deleted.length)
      await tx.delete(entityIdentity).where(
        and(
          eq(entityIdentity.kind, "job"),
          inArray(
            entityIdentity.id,
            deleted.map((row) => row.id),
          ),
        ),
      );
    return deleted.length;
  });
}

/**
 * Delete one bounded batch of acknowledged captures. New input is a distinct
 * UUID row and is never selected; the admitted Job retains recovery ownership.
 */
export async function pruneObservedInvalidationCaptures(
  db: Database,
  { limit }: { limit: number },
): Promise<number> {
  const doomed = getDb(db)
    .select({ id: jobInvalidationCapture.id })
    .from(jobInvalidationCapture)
    .where(eq(jobInvalidationCapture.observed, true))
    .limit(limit);
  const deleted = await getDb(db)
    .delete(jobInvalidationCapture)
    .where(inArray(jobInvalidationCapture.id, doomed))
    .returning({ id: jobInvalidationCapture.id });
  return deleted.length;
}

/** Old retention during cutover could prune a backfilled Job without its new identity. */
export async function pruneOrphanJobIdentities(
  db: Database,
  { limit }: { limit: number },
): Promise<number> {
  const orphan = sql`NOT ${related(job, (row) => sql`${row.id} = ${outer(entityIdentity.id)}`).exists()}`;
  const doomed = getDb(db)
    .select({ id: entityIdentity.id })
    .from(entityIdentity)
    .where(and(eq(entityIdentity.kind, "job"), orphan))
    .limit(limit);
  const deleted = await getDb(db)
    .delete(entityIdentity)
    .where(inArray(entityIdentity.id, doomed))
    .returning({ id: entityIdentity.id });
  return deleted.length;
}
