/**
 * The Job queue's private core: due selection, claims, leases, publication
 * and failure. Producers, operators and external executors reach it only
 * through `producer.ts` and `operator.ts`; the drain executor
 * (`service/jobs.ts`) is its one internal caller.
 */
import {
  JOB_FAILING_LIMIT_MS,
  jobPage,
  type JobExecution,
  type JobPage,
} from "@cubby/schemas/job";
import { runStatus, VISIBLE_RUN_PURPOSES } from "@cubby/schemas/run-fields";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryBeforeCommit,
  repositoryQueries,
  repositorySnapshotWriteDatabase,
  repositoryTransactionDatabase,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job, run } from "~/server/db/retained-tables";

import { JobSupersededError } from "../errors";
import { classifyJobFailure } from "../failure";
import {
  jobKindPolicy,
  jobRetryDelayMs,
  type JOB_KIND_POLICY,
} from "../kind-policy";

/** How long a claim holds a Job before another worker may take it over. */
const JOB_LEASE_MS = 16 * 60_000;
export type JobRow = typeof job.$inferSelect;
export type JobClaim = JobRow & {
  leaseToken: string;
  leaseExpiresAt: Date;
};

/** Rows written before every kind had a bound keep a null column; the policy bounds them. */
const attemptLimit = (row: Pick<JobRow, "kind" | "maxAttempts">) =>
  row.maxAttempts ?? jobKindPolicy(row.kind).maxAttempts;

/** Whether `row` is still owned by `claim`: same token and generation, live. */
const ownsLease = (
  row: Pick<JobRow, "state" | "leaseToken" | "leaseExpiresAt" | "generation">,
  claim: Pick<JobClaim, "leaseToken" | "generation">,
) =>
  row.state === "running" &&
  row.leaseToken === claim.leaseToken &&
  row.generation === claim.generation &&
  row.leaseExpiresAt !== null &&
  row.leaseExpiresAt.getTime() > Date.now();

export const jobDue = (now: Date) =>
  or(
    and(
      inArray(job.state, ["queued", "retry_wait"]),
      sql`${job.availableAt} <= ${now.toISOString()}::timestamp`,
    ),
    and(
      eq(job.state, "running"),
      sql`${job.leaseExpiresAt} <= ${now.toISOString()}::timestamp`,
    ),
  );

/** The record row a drain unit's executions write: rotation and outcome. */
export const DRAIN_RECORD_KIND =
  "background.drain" satisfies keyof typeof JOB_KIND_POLICY;
const drainRecordKey = (unit: string) => `drain:${unit}`;

export type DueUnit =
  | { type: "job"; id: string; unit: string; runOwned: boolean }
  /** `drain` is the registered drain whose `due` SQL reported the unit. */
  | { type: "drain"; unit: string; drain: string; runOwned: boolean };

/** A registered drain's name and its `due` rows `(unit, demand, since)`. */
export type DrainDue = { name: string; due: SQL };

/** Candidate Jobs per kind, so a busy head never empties a permit's choice. */
const PER_KIND = 4;

/**
 * One statement chooses what a permit runs: due Jobs and every drain's due
 * units. Member-visible Run work leads; then units take turns, least recently
 * served first (a Job kind's latest claim, a drain unit's record row); within
 * a kind, the longest due first, each priority point a minute's head start.
 * Priority is a head start, never an absolute rank: deferred Jobs that fall
 * due again every few seconds would otherwise hold every candidate slot and
 * starve a lower priority for good. A 100k flood of one kind therefore never
 * starves another, and an idle household answers with no rows.
 *
 * Each drain unit carries the name of the drain that reported it, so a permit
 * runs the unit on that drain whatever the unit is called: a unit name is a
 * label for rotation and telemetry, never a routing key.
 */
export async function dueUnits(
  db: Database,
  drains: readonly DrainDue[],
  limit: number,
): Promise<DueUnit[]> {
  const now = new Date();
  const drainRows = drains.length
    ? sql.join(
        drains.map(
          ({ name, due }) =>
            sql`(SELECT ${name}::text AS drain, reported.unit, reported.demand, reported.since FROM (${due}) reported)`,
        ),
        sql` UNION ALL `,
      )
    : sql`SELECT NULL::text AS drain, NULL::text AS unit, false AS demand, NULL::timestamp AS since WHERE false`;
  const result = await repositoryQueries(db).execute<{
    type: "job" | "drain";
    ref: string;
    unit: string;
    drain: string | null;
    run_owned: boolean;
  }>(sql`
    WITH active_runs AS MATERIALIZED (
      SELECT id, purpose IN (${sql.join(
        VISIBLE_RUN_PURPOSES.map((purpose) => sql`${purpose}`),
        sql`, `,
      )}) AS visible
      FROM "Run" WHERE status = ${runStatus.enum.running} AND ${notDeleted(run)}
    ), jobs AS (
      SELECT "Job".id, "Job".kind, "Job".priority, "Job"."availableAt" AS since,
        ("Job".kind = 'run.execute' OR coalesce(active_runs.visible, false)) AS run_owned
      FROM "Job" LEFT JOIN active_runs ON active_runs.id = "Job"."runId"
      WHERE ${jobDue(now)}
    ), ranked AS (
      SELECT jobs.*, row_number() OVER (
        PARTITION BY run_owned, kind
        ORDER BY since - priority * interval '1 minute', priority DESC, id
      ) AS position FROM jobs
    ), drain_units AS (${drainRows}), units AS (
      SELECT 'job' AS type, id::text AS ref, kind AS unit, NULL::text AS drain, run_owned, priority, since, position
      FROM ranked WHERE position <= ${PER_KIND}
      UNION ALL
      SELECT 'drain', unit, unit, drain, demand, 0, since, 1 FROM drain_units
    )
    SELECT units.type, units.ref, units.unit, units.drain, units.run_owned FROM units
    ORDER BY units.run_owned DESC, units.position,
      CASE WHEN units.type = 'job'
        THEN (SELECT max("lastClaimedAt") FROM "Job" WHERE kind = units.unit)
        ELSE (SELECT "lastClaimedAt" FROM "Job" WHERE key = 'drain:' || units.unit)
      END NULLS FIRST,
      units.priority DESC, units.since, units.unit
    LIMIT ${limit}`);
  return result.rows.map((row) =>
    row.type === "job"
      ? { type: "job", id: row.ref, unit: row.unit, runOwned: row.run_owned }
      : {
          type: "drain",
          unit: row.unit,
          drain: row.drain ?? row.unit,
          runOwned: row.run_owned,
        },
  );
}

/**
 * When owed work next becomes claimable: a queued Job, a held lease lapsing,
 * or any drain's own `next`. May be in the past.
 */
export async function nextDueAt(
  db: RepositoryQueryInput,
  drains: readonly SQL[],
): Promise<Date | null> {
  const until = sql`CASE WHEN ${job.state} = ${"running"} THEN ${job.leaseExpiresAt} ELSE ${job.availableAt} END`;
  const jobs = sql`(SELECT min(${until}) FROM "Job" WHERE ${inArray(job.state, ["queued", "retry_wait", "running"])})`;
  const result = await repositoryQueries(db).execute<{ at: number | null }>(
    // Epoch milliseconds: the driver would read a zoneless timestamp as local time.
    sql`SELECT (extract(epoch FROM least(${sql.join(
      [jobs, ...drains.map((next) => sql`(${next})`)],
      sql`, `,
    )})) * 1000)::float8 AS at`,
  );
  const at = result.rows[0]?.at;
  // A parked row (`infinity`) is never due.
  return at == null || !Number.isFinite(at) ? null : new Date(at);
}

/**
 * Record one execution on its Job row (a Job, or a drain unit's record row).
 * A Job's failure state is `failJob`'s. A drain unit has no other owner, so
 * its record row keeps a failed page's raw error and the start of the failing
 * streak; a page that succeeded or deferred ends the streak, and a page that
 * claimed nothing leaves it as it was.
 *
 * Only the latest execution is stored, so a row that defers every few seconds
 * would otherwise never show how long it has been deferring: the record
 * carries `deferringSince` from the first deferral of the run to the latest.
 */
export async function recordJobExecution(
  db: RepositoryQueryInput,
  target:
    | { id: string; generation: number; claimedAt: Date | null }
    | { unit: string; error?: UnparsedError },
  execution: JobExecution,
) {
  const failed = execution.outcome === "failed";
  const deferred = execution.outcome === "deferred";
  const record = JSON.stringify(
    deferred
      ? { ...execution, deferringSince: execution.finishedAt }
      : execution,
  );
  await repositoryQueries(db)
    .update(job)
    .set({
      lastExecution:
        deferred || execution.outcome === "skipped"
          ? sql`${record}::jsonb || CASE WHEN ${job.lastExecution}->>'deferringSince' IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('deferringSince', ${job.lastExecution}->'deferringSince') END`
          : execution,
      ...("unit" in target &&
        execution.outcome !== "skipped" && {
          error: failed
            ? JSON.stringify(describeErrorCauses(target.error))
            : null,
          failingSince: failed
            ? sql`coalesce(${job.failingSince}, ${execution.finishedAt}::timestamp)`
            : null,
        }),
    })
    .where(
      "id" in target
        ? // A superseded executor's late record matches nothing: a newer claim
          // moved the generation or the claim time.
          and(
            eq(job.id, target.id),
            eq(job.generation, target.generation),
            target.claimedAt
              ? eq(job.lastClaimedAt, target.claimedAt)
              : sql`false`,
          )
        : eq(job.key, drainRecordKey(target.unit)),
    );
}

/** Whether a Job claim is still held by `lease` and its lease lapsed: its invocation died. */
export async function jobLeaseLapsed(
  db: RepositoryQueryInput,
  id: string,
  lease: string,
) {
  const [row] = await repositoryQueries(db)
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        eq(job.id, id),
        eq(job.state, "running"),
        eq(job.leaseToken, lease),
        sql`${job.leaseExpiresAt} <= ${new Date().toISOString()}::timestamp`,
      ),
    );
  return row !== undefined;
}

/** Stamp a drain unit's service before its page: rotation counts the attempt. */
export async function claimDrainUnit(db: RepositoryQueryInput, unit: string) {
  const now = new Date();
  await repositoryQueries(db)
    .insert(job)
    .values({
      key: drainRecordKey(unit),
      kind: DRAIN_RECORD_KIND,
      state: "completed",
      input: { unit },
      lastClaimedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: job.key,
      set: { lastClaimedAt: now, updatedAt: now },
    });
}

/**
 * Skip a busy Job immediately; a claim never waits behind another worker.
 * Claiming is not an attempt, but reclaiming an expired lease is: the last
 * executor vanished mid-page, and a crash loop must still exhaust.
 */
export async function claimJob(
  db: Database,
  id: string,
  leaseMs = JOB_LEASE_MS,
): Promise<JobClaim | null> {
  const recordId = id;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new Error("Job lease must be a positive finite duration");
  const now = new Date();
  const token = crypto.randomUUID();
  return repositoryTransactionDatabase(db, async (tx) => {
    const [candidate] = await repositoryQueries(tx)
      .select({ row: job })
      .from(job)
      .where(and(eq(job.id, recordId), jobDue(now)))
      .for("update", { of: job, skipLocked: true });
    if (!candidate) return null;
    const { row } = candidate;
    const attempts = row.attempts + (row.state === "running" ? 1 : 0);
    if (attempts >= attemptLimit(row)) {
      await repositoryQueries(tx)
        .update(job)
        .set({
          state: "failed",
          attempts,
          waitReason: null,
          leaseToken: null,
          leaseExpiresAt: null,
          error: "Job exhausted attempts after interrupted execution",
          updatedAt: now,
        })
        .where(eq(job.id, recordId));
      return null;
    }
    const expires = new Date(now.getTime() + leaseMs);
    const [claimed] = await repositoryQueries(tx)
      .update(job)
      .set({
        state: "running",
        waitReason: null,
        leaseToken: token,
        leaseExpiresAt: expires,
        attempts,
        lastClaimedAt: now,
        updatedAt: now,
      })
      .where(eq(job.id, recordId))
      .returning();
    return claimed
      ? { ...claimed, leaseToken: token, leaseExpiresAt: expires }
      : null;
  });
}

/** Used by domain receipt transactions before applying externally prepared results. */
export async function assertJobClaim(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation">,
  lock?: "update",
) {
  const query = repositoryQueries(db)
    .select({ leaseExpiresAt: job.leaseExpiresAt })
    .from(job)
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.generation, claim.generation),
        eq(job.leaseToken, claim.leaseToken),
      ),
    );
  const [current] = await (lock ? query.for(lock) : query);
  if (
    !current?.leaseExpiresAt ||
    current.leaseExpiresAt.getTime() <= Date.now()
  )
    throw new JobSupersededError();
}

/**
 * Commit `tx` only while `claim` owns its Job. Lock the Job row before
 * commit, after every domain lock: saves and
 * cancellation also take domain rows before the Job, and a shared lock
 * upgraded at commit would deadlock against them.
 */
export async function fenceJob(
  tx: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation">,
) {
  await repositoryBeforeCommit(
    tx,
    (commit) => assertJobClaim(commit, claim, "update"),
    { phase: "publication" },
  );
}

/** A transaction that commits only while `claim` still owns its Job (`JobContext.fenced`). */
export function fencedJobTransaction<T>(
  db: Database,
  claim: JobClaim,
  work: (tx: Database) => Promise<T>,
  isolationLevel?: "serializable",
): Promise<T> {
  return (
    isolationLevel === "serializable"
      ? repositorySnapshotWriteDatabase
      : repositoryTransactionDatabase
  )(db, async (tx) => {
    await fenceJob(tx, claim);
    return work(tx);
  });
}

/** Preparation/provider work precedes this short transaction; publish is DB-only. */
export async function publishJobPage(
  db: Database,
  claim: JobClaim,
  submitted: JobPage,
  publish?: (tx: Database) => Promise<void | JobPage["result"]>,
  isolationLevel?: "serializable",
): Promise<boolean> {
  const page = jobPage.parse(submitted);
  const transaction =
    isolationLevel === "serializable"
      ? repositorySnapshotWriteDatabase
      : repositoryTransactionDatabase;
  return transaction(db, async (tx) => {
    // An unlocked probe skips stale work; the commit hook is the fence.
    const [current] = await repositoryQueries(tx)
      .select()
      .from(job)
      .where(eq(job.id, claim.id));
    if (!current || !ownsLease(current, claim)) return false;
    await publish?.(tx);
    await repositoryBeforeCommit(
      tx,
      async (commit) => {
        const [latest] = await repositoryQueries(commit)
          .select()
          .from(job)
          .where(eq(job.id, claim.id))
          .for("update");
        if (!latest || !ownsLease(latest, claim))
          throw new JobSupersededError();
        await repositoryQueries(commit)
          .update(job)
          .set({
            state: page.done ? "completed" : "queued",
            cursor: page.cursor ?? null,
            availableAt: page.waitUntil ?? page.availableAt ?? new Date(),
            waitReason: page.done ? null : (page.waitReason ?? null),
            leaseToken: null,
            leaseExpiresAt: null,
            attempts: 0,
            error: null,
            // A successful or deferred page ends any failing streak.
            failingSince: null,
            updatedAt: new Date(),
          })
          .where(eq(job.id, claim.id));
      },
      { phase: "publication" },
    );
    return true;
  });
}

const ownedBy = (claim: Pick<JobClaim, "id" | "leaseToken" | "generation">) =>
  and(
    eq(job.id, claim.id),
    eq(job.state, "running"),
    eq(job.leaseToken, claim.leaseToken),
    eq(job.generation, claim.generation),
  );

/**
 * A failure backs off by kind policy. Ordinary failures count toward
 * `maxAttempts`; transient ones (a pool-slot timeout, a snapshot conflict) do
 * not, but nothing keeps failing past `JOB_FAILING_LIMIT_MS` without failing
 * visibly. Deferrals never reach here.
 */
export async function failJob(
  db: RepositoryQueryInput,
  claim: JobClaim,
  error: UnparsedError,
) {
  const { backoff } = jobKindPolicy(claim.kind);
  const transient = classifyJobFailure(error).kind === "transient";
  const failures = claim.attempts + 1;
  const now = Date.now();
  const failingSince = claim.failingSince ?? new Date(now);
  const exhausted =
    (!transient && failures >= attemptLimit(claim)) ||
    now - failingSince.getTime() >= JOB_FAILING_LIMIT_MS;
  await repositoryQueries(db)
    .update(job)
    .set({
      state: exhausted ? "failed" : "retry_wait",
      // A transient failure is retried without spending the attempt budget.
      attempts: transient ? claim.attempts : failures,
      failingSince,
      // Transient backoff grows with the streak's age instead of its attempts.
      availableAt: new Date(
        now +
          (transient
            ? Math.min(
                backoff.maxMs,
                Math.max(backoff.baseMs, now - failingSince.getTime()),
              )
            : jobRetryDelayMs(backoff, failures)),
      ),
      waitReason: null,
      leaseToken: null,
      leaseExpiresAt: null,
      error: JSON.stringify(describeErrorCauses(error)),
      updatedAt: new Date(),
    })
    .where(ownedBy(claim));
}

export async function pauseClaimedJob(
  db: RepositoryQueryInput,
  claim: JobClaim,
  error: UnparsedError,
) {
  await repositoryQueries(db)
    .update(job)
    .set({
      state: "paused",
      waitReason: null,
      leaseToken: null,
      leaseExpiresAt: null,
      error: JSON.stringify(describeErrorCauses(error)),
      updatedAt: new Date(),
    })
    .where(ownedBy(claim));
}
