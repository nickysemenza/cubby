/**
 * The Job queue's private core: due selection, claims, leases, publication
 * and failure. Producers, operators and external executors reach it only
 * through `producer.ts`, `operator.ts` and `external-claim.ts`; the drain
 * executor (`service/jobs.ts`) is its one internal caller.
 */
import { parseEntityId } from "@cubby/schemas/identifiers";
import { jobPage, type JobPage, type JobWaitReason } from "@cubby/schemas/job";
import { runStatus, VISIBLE_RUN_PURPOSES } from "@cubby/schemas/run-fields";
import { and, eq, gt, inArray, not, notInArray, or, sql } from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { outer, related } from "~/server/db/helpers/related";
import {
  repositoryBeforeCommit,
  repositoryQueries,
  repositorySnapshotWriteDatabase,
  repositoryTransactionDatabase,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job, jobInvalidationCapture, run } from "~/server/db/retained-tables";

import { JobSupersededError } from "../errors";
import { classifyJobFailure } from "../failure";
import {
  jobKindPolicy,
  jobRetryDelayMs,
  UNDRAINED_JOB_KINDS,
} from "../kind-policy";
import { JOB_DRAIN } from "../limits";

/** How long a claim holds a Job before another worker may take it over. */
const JOB_LEASE_MS = 5 * 60_000;
export type JobRow = typeof job.$inferSelect;
export type JobClaim = JobRow & {
  leaseToken: string;
  leaseExpiresAt: Date;
  /**
   * An external executor reporting after its lease expired still owns the
   * Job while no newer claim replaced its token; only such a claim may
   * publish past `leaseExpiresAt`.
   */
  lateAdoption?: true;
};

/** Whether `row` is still owned by `claim`: same token and generation, live unless adopted late. */
const ownsLease = (
  row: Pick<JobRow, "state" | "leaseToken" | "leaseExpiresAt" | "generation">,
  claim: Pick<JobClaim, "leaseToken" | "generation" | "lateAdoption">,
) =>
  row.state === "running" &&
  row.leaseToken === claim.leaseToken &&
  row.generation === claim.generation &&
  row.leaseExpiresAt !== null &&
  (claim.lateAdoption === true || row.leaseExpiresAt.getTime() > Date.now());

/**
 * A wake this Job has not observed yet. OFFSET keeps the finite key set out
 * of a correlated nested-loop plan.
 */
export const unobservedJobInvalidation = () =>
  sql<boolean>`${job.key} IN (SELECT DISTINCT capture.key FROM "JobInvalidationCapture" capture
    WHERE NOT capture.observed OFFSET 0)`;

/** Key membership for predicates that scan many Jobs (reaches woken rows by `Job_key_unique`). */
const unobservedJobInvalidationKey = () =>
  sql<boolean>`${job.key} = ANY (ARRAY(SELECT DISTINCT c.key FROM ${jobInvalidationCapture} c WHERE NOT c.observed))`;

const scheduledDue = (now: Date) =>
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

/**
 * A wake makes finished work and a sleeping pass due at once. Failure backoff,
 * typed waits and member stops (paused, cancelled, failed) never wake.
 */
const wakeDue = () =>
  or(
    eq(job.state, "completed"),
    and(eq(job.state, "queued"), sql`${job.waitReason} IS NULL`),
  );

const due = (now: Date) =>
  or(scheduledDue(now), and(wakeDue(), unobservedJobInvalidationKey()));

/** Whether a Job is claimable now: the one predicate the drain, claims and diagnostics share. */
export const jobDue = (now: Date) => due(now);

/** A running, member-visible Run that owns the outer `"Job"` row. */
const runOwningJob = () =>
  related(run, (r) => sql`${r.id} = ${outer(job.runId)}`)
    .where(
      (r) =>
        sql`${r.status} = ${runStatus.enum.running} AND ${r.purpose} IN (${sql.join(
          VISIBLE_RUN_PURPOSES.map((purpose) => sql`${purpose}`),
          sql`, `,
        )})`,
    )
    .exists();

/** Whether the outer `"Job"` row belongs to a running, member-visible Run. */
export const jobRunOwned = () =>
  sql<boolean>`("Job"."runId" IS NOT NULL AND ${runOwningJob()})`;

/** Run execution and work of any active Run bypass kind admission. */
const jobCapExempt = () =>
  sql<boolean>`(${job.kind} = 'run.execute' OR ${related(
    run,
    (r) =>
      sql`${r.id} = ${outer(job.runId)} AND ${r.status} = ${runStatus.enum.running}`,
  ).exists()})`;

/** A kind's `maxInFlight` across Workers; never waits while holding the candidate. */
async function admitJobKind(tx: Database, kind: string, now: Date) {
  const cap = jobKindPolicy(kind).maxInFlight;
  if (cap === undefined) return true;
  const admission = await repositoryQueries(tx).execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`job-kind:${kind}`}, 0)) AS locked`,
  );
  if (!admission.rows[0]?.locked) return false;
  const [live] = await repositoryQueries(tx)
    .select({ count: sql<number>`count(*)::int` })
    .from(job)
    .where(
      and(
        eq(job.kind, kind),
        eq(job.state, "running"),
        gt(job.leaseExpiresAt, now),
        not(jobCapExempt()),
      ),
    );
  return (live?.count ?? 0) < cap;
}

/**
 * One fair batch. Run-owned Jobs lead; then kinds take turns, least recently
 * claimed first (only a claim is service, so wakes and enqueues leave
 * `lastClaimedAt`); within a kind, priority then age.
 */
export async function dueJobs(
  db: Database,
  limit = JOB_DRAIN.batch,
  { excludeIds = [] }: { excludeIds?: readonly string[] } = {},
) {
  const now = new Date();
  const result = await repositoryQueries(db).execute<{
    id: string;
    kind: string;
    run_owned: boolean;
  }>(sql`
    WITH active_runs AS MATERIALIZED (
      SELECT id, purpose IN (${sql.join(
        VISIBLE_RUN_PURPOSES.map((purpose) => sql`${purpose}`),
        sql`, `,
      )}) AS visible
      FROM "Run" WHERE status = ${runStatus.enum.running} AND ${notDeleted(run)}
    ), pending AS MATERIALIZED (
      SELECT DISTINCT key FROM "JobInvalidationCapture" WHERE NOT observed
    ), due AS MATERIALIZED (
      -- Timed work and wakes scan separately: terminal history never enters
      -- the timed scan just to test the wake predicate.
      SELECT id, kind, priority, "updatedAt", "runId" FROM "Job"
      WHERE ${scheduledDue(now)} AND ${notInArray(job.kind, [...UNDRAINED_JOB_KINDS])}
      UNION ALL
      SELECT "Job".id, "Job".kind, "Job".priority, "Job"."updatedAt", "Job"."runId"
      FROM pending JOIN "Job" USING (key)
      WHERE ${wakeDue()} AND ${notInArray(job.kind, [...UNDRAINED_JOB_KINDS])}
        AND (${scheduledDue(now)}) IS NOT TRUE
    ), candidates AS (
      SELECT due.id, due.kind, due.priority, due."updatedAt",
        (due.kind = 'run.execute' OR coalesce(active_runs.visible, false)) AS run_owned
      FROM due LEFT JOIN active_runs ON active_runs.id = due."runId"
      ${
        excludeIds.length
          ? sql`WHERE due.id NOT IN (${sql.join(
              excludeIds.map((id) => sql`${parseEntityId("job", id)}::uuid`),
              sql`, `,
            )})`
          : sql``
      }
    ), served AS (
      SELECT kinds.kind, latest."lastClaimedAt" AS last_served
      FROM (SELECT DISTINCT kind FROM candidates) kinds
      LEFT JOIN LATERAL (
        SELECT "lastClaimedAt" FROM "Job" WHERE kind = kinds.kind AND "lastClaimedAt" IS NOT NULL
        ORDER BY "lastClaimedAt" DESC LIMIT 1
      ) latest ON true
    ), ranked AS (
      SELECT candidates.*, row_number() OVER (
        PARTITION BY run_owned, kind ORDER BY priority DESC, "updatedAt", id
      ) AS position FROM candidates
    )
    SELECT ranked.id, ranked.kind, ranked.run_owned FROM ranked JOIN served USING (kind)
    ORDER BY ranked.run_owned DESC, ranked.position, served.last_served NULLS FIRST, ranked.kind
    LIMIT ${limit}`);
  return result.rows.map((row) => ({
    id: parseEntityId("job", row.id),
    kind: row.kind,
    runOwned: row.run_owned,
  }));
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
  const recordId = parseEntityId("job", id);
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new Error("Job lease must be a positive finite duration");
  const now = new Date();
  const token = crypto.randomUUID();
  return repositoryTransactionDatabase(db, async (tx) => {
    const [candidate] = await repositoryQueries(tx)
      .select({
        row: job,
        woken: unobservedJobInvalidation(),
        capExempt: jobCapExempt(),
      })
      .from(job)
      .where(and(eq(job.id, recordId), due(now)))
      .for("update", { of: job, skipLocked: true });
    if (!candidate) return null;
    const { row } = candidate;
    if (!candidate.capExempt && !(await admitJobKind(tx, row.kind, now)))
      return null;
    // A woken finished Job starts a fresh pass.
    const fresh = candidate.woken && row.state === "completed";
    const attempts = fresh
      ? 0
      : row.attempts + (row.state === "running" ? 1 : 0);
    if (row.maxAttempts !== null && attempts >= row.maxAttempts) {
      await repositoryQueries(tx)
        .update(job)
        .set({
          state: "failed",
          attempts,
          waitReason: null,
          waitUntil: null,
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
        waitUntil: null,
        leaseToken: token,
        leaseExpiresAt: expires,
        attempts,
        lastClaimedAt: now,
        updatedAt: now,
        ...(fresh && { cursor: null, result: null, error: null }),
      })
      .where(eq(job.id, recordId))
      .returning();
    // This exact visible set is observed; a capture committed later stays
    // pending and makes the Job due again after this pass.
    if (claimed && candidate.woken)
      await repositoryQueries(tx)
        .update(jobInvalidationCapture)
        .set({ observed: true })
        .where(
          and(
            eq(jobInvalidationCapture.key, claimed.key),
            eq(jobInvalidationCapture.observed, false),
          ),
        );
    return claimed
      ? { ...claimed, leaseToken: token, leaseExpiresAt: expires }
      : null;
  });
}

/** The token, not the elapsed wall clock alone, owns publication. */
export async function renewJob(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation">,
  leaseMs = JOB_LEASE_MS,
): Promise<boolean> {
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({
      leaseExpiresAt: new Date(Date.now() + leaseMs),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
        eq(job.generation, claim.generation),
        sql`${job.leaseExpiresAt} > now()`,
      ),
    )
    .returning({ id: job.id });
  return Boolean(row);
}

/**
 * Hand a claim back without counting an attempt: the executor stopped (or
 * the server could not hand the work over), not the work failing. The Job is
 * due again immediately unless `availableAt` says otherwise.
 */
export async function releaseJobClaim(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation">,
  {
    availableAt = new Date(),
    waitReason = null,
  }: { availableAt?: Date; waitReason?: JobWaitReason | null } = {},
) {
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({
      state: "queued",
      waitReason,
      waitUntil: waitReason ? availableAt : null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
        eq(job.generation, claim.generation),
      ),
    )
    .returning({ id: job.id });
  return Boolean(row);
}

/** Used by domain receipt transactions before applying externally prepared results. */
export async function assertJobClaim(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation" | "lateAdoption">,
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
    (!claim.lateAdoption && current.leaseExpiresAt.getTime() <= Date.now())
  )
    throw new JobSupersededError();
}

/**
 * Commit `tx` only while `claim` owns its Job. Checks cheaply now, then locks
 * the Job row once before commit, after every domain lock: saves and
 * cancellation also take domain rows before the Job, and a shared lock
 * upgraded at commit would deadlock against them.
 */
export async function fenceJob(
  tx: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation" | "lateAdoption">,
) {
  await assertJobClaim(tx, claim);
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
    const publication = await publish?.(tx);
    const output = publication === undefined ? page.result : publication;
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
            result:
              output &&
              typeof output === "object" &&
              !Array.isArray(output) &&
              latest.result &&
              typeof latest.result === "object" &&
              !Array.isArray(latest.result)
                ? { ...latest.result, ...output }
                : (output ?? latest.result),
            availableAt: page.waitUntil ?? page.availableAt ?? new Date(),
            waitReason: page.done ? null : (page.waitReason ?? null),
            waitUntil: page.done ? null : (page.waitUntil ?? null),
            leaseToken: null,
            leaseExpiresAt: null,
            attempts: 0,
            error: null,
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

export async function failJob(
  db: RepositoryQueryInput,
  claim: JobClaim,
  error: UnparsedError,
) {
  const { backoff } = jobKindPolicy(claim.kind);
  const transient = classifyJobFailure(error).kind === "transient";
  const failures = claim.attempts + 1;
  const exhausted =
    !transient && claim.maxAttempts !== null && failures >= claim.maxAttempts;
  await repositoryQueries(db)
    .update(job)
    .set({
      state: exhausted ? "failed" : "retry_wait",
      attempts: failures,
      // A transient failure reserves its next attempt.
      ...(transient && claim.maxAttempts !== null
        ? { maxAttempts: Math.max(claim.maxAttempts, failures + 1) }
        : {}),
      availableAt: new Date(Date.now() + jobRetryDelayMs(backoff, failures)),
      waitReason: null,
      waitUntil: null,
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
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      error: JSON.stringify(describeErrorCauses(error)),
      updatedAt: new Date(),
    })
    .where(ownedBy(claim));
}

/**
 * Companion receipts use the exact universal claim that authorized their
 * capability. `lateAdoption` also returns an expired lease no newer claim has
 * replaced, so a late result is adopted rather than dropped.
 */
export async function externalJobClaim(
  db: RepositoryQueryInput,
  key: string,
  token?: string,
  lock = false,
  { lateAdoption = false }: { lateAdoption?: boolean } = {},
): Promise<JobClaim | null> {
  const query = repositoryQueries(db)
    .select()
    .from(job)
    .where(
      and(
        eq(job.key, key),
        eq(job.state, "running"),
        token ? eq(job.leaseToken, token) : undefined,
      ),
    );
  const [row] = await (lock ? query.for("update") : query);
  if (!row?.leaseToken || !row.leaseExpiresAt) return null;
  const claim = {
    ...row,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
  };
  if (row.leaseExpiresAt.getTime() > Date.now()) return claim;
  return lateAdoption ? { ...claim, lateAdoption: true as const } : null;
}
