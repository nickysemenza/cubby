import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  jobState,
  enqueueJobInput,
  jobPage,
  type EnqueueJobInput,
  type JobPage,
  type JobWaitReason,
} from "@cubby/schemas/job";
import { runStatus, VISIBLE_RUN_PURPOSES } from "@cubby/schemas/run-fields";
import {
  and,
  eq,
  gt,
  inArray,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
  repositorySnapshotWriteDatabase,
} from "~/server/db/repository-access.boundary";
import {
  repositoryBeforeCommit,
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job, jobInvalidation } from "~/server/db/retained-tables";

import { JobSupersededError } from "../errors";
import {
  jobKindPolicy,
  neverExhaustedRetryDelayMs,
  NEVER_EXHAUSTED_JOB_KINDS,
  UNDRAINED_JOB_KINDS,
} from "../kind-policy";
import { JOB_DRAIN } from "../limits";

/** How long a claim holds a Job before another worker may take it over. */
export const JOB_LEASE_MS = 5 * 60_000;
/** Consecutive failures before a Job fails; an enqueue may declare its own. */
export const DEFAULT_JOB_MAX_ATTEMPTS = 3;
/** A failed page waits `baseMs · 2^attempts`, capped at `maxMs`. */
export const JOB_RETRY_BACKOFF = { baseMs: 1_000, maxMs: 60_000 } as const;
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

/** Whether `row` is still owned by `claim`: same token, and live unless adopted late. */
const ownsLease = (
  row: {
    state: string;
    leaseToken: string | null;
    leaseExpiresAt: Date | null;
  },
  claim: Pick<JobClaim, "leaseToken" | "lateAdoption">,
) =>
  row.state === "running" &&
  row.leaseToken === claim.leaseToken &&
  row.leaseExpiresAt !== null &&
  (claim.lateAdoption === true || row.leaseExpiresAt.getTime() > Date.now());

/** Call inside the authoritative save transaction; a queue message is only a wake. */
export async function enqueueJob(
  db: RepositoryQueryInput,
  submitted: EnqueueJobInput,
): Promise<JobRow> {
  const input = enqueueJobInput.parse(submitted);
  const client = repositoryQueries(db);
  const values = {
    key: input.key,
    kind: input.kind,
    input: input.input,
    subjectKind: input.subjectKind ?? null,
    subjectId: input.subjectId ?? null,
    runId: input.runId ? parseEntityId("run", input.runId) : null,
    priority: input.priority ?? 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
    recoveryTimeoutMs: input.recoveryTimeoutMs ?? null,
    lastUsefulProgressAt: input.recoveryTimeoutMs ? new Date() : null,
    availableAt: input.availableAt ?? new Date(),
  };
  const insertion = client.insert(job).values(values);
  const [created] = input.invalidate
    ? await insertion
        .onConflictDoUpdate({
          target: job.key,
          set: {
            ...values,
            recoveryTimeoutMs:
              input.recoveryTimeoutMs ?? sql`${job.recoveryTimeoutMs}`,
            lastUsefulProgressAt: sql`CASE WHEN coalesce(${input.recoveryTimeoutMs ?? null}, ${job.recoveryTimeoutMs}) IS NOT NULL THEN ${new Date().toISOString()}::timestamp ELSE NULL END`,
            generation: sql`${job.generation} + 1`,
            state: sql`CASE WHEN ${job.state}=${jobState.enum.running} THEN ${jobState.enum.running} ELSE ${jobState.enum.queued} END`,
            cursor: null,
            result: null,
            attempts: 0,
            error: null,
            waitReason: null,
            waitUntil: null,
            updatedAt: new Date(),
          },
          setWhere: and(
            eq(job.kind, input.kind),
            inArray(job.state, [
              "queued",
              "retry_wait",
              "running",
              "completed",
            ]),
          ),
        })
        .returning()
    : await insertion.onConflictDoNothing().returning();
  const row =
    created ??
    (await client.select().from(job).where(eq(job.key, input.key)))[0];
  if (!row) throw new Error(`Job disappeared while enqueuing ${input.key}`);
  if (row.kind !== input.kind)
    throw new Error(
      `Job key ${input.key} belongs to ${row.kind}, not ${input.kind}`,
    );
  return row;
}

/**
 * A durable invalidation this Job has not observed yet (`JobInvalidation`):
 * outstanding work even while the Job row itself reads `completed`.
 */
export const unobservedJobInvalidation = () =>
  // Qualified by hand: drizzle renders bare column names in some statements,
  // which inside this subquery would compare the marker with itself.
  sql<boolean>`EXISTS (SELECT 1 FROM "JobInvalidation" ji WHERE ji.key = "Job".key AND ji.revision > coalesce("Job"."observedRevision", 0))`;

/** Whether a Job is claimable now: the one predicate the drain, claims and health share. */
export const jobDue = (now: Date) => due(now);

const due = (now: Date) =>
  or(
    and(
      inArray(job.state, ["queued", "retry_wait"]),
      lte(job.availableAt, now),
    ),
    and(eq(job.state, "running"), lte(job.leaseExpiresAt, now)),
    // A captured invalidation wakes waiting or finished work at once.
    and(
      inArray(job.state, ["queued", "retry_wait", "completed"]),
      unobservedJobInvalidation(),
    ),
  );

/**
 * Record durable source invalidation of `key` in the caller's transaction.
 * It writes only the `JobInvalidation` row, never the execution `Job` row,
 * so a capture cannot conflict with claims, renewals or publication of that
 * Job. `restartsPass: false` lets a pass in progress finish before it reruns.
 * The first capture of a key creates its Job when none exists.
 */
export async function recordJobInvalidation(
  db: RepositoryQueryInput,
  input: Omit<EnqueueJobInput, "invalidate"> & { restartsPass: boolean },
) {
  const { restartsPass, ...enqueue } = input;
  const [marker] = await repositoryQueries(db)
    .insert(jobInvalidation)
    .values({ key: enqueue.key, restartsPass })
    .onConflictDoUpdate({
      target: jobInvalidation.key,
      set: {
        revision: sql`${jobInvalidation.revision} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ revision: jobInvalidation.revision });
  if (marker?.revision === 1) await enqueueJob(db, enqueue);
}

/** Expiry revokes ownership; it never reclaims a live lease for another execution. */
async function stopStalledJobs(db: Database) {
  await getDb(db)
    .update(job)
    .set({
      state: "failed",
      error: "Job stopped after its useful-progress recovery window expired",
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(job.state, ["queued", "retry_wait", "running"]),
        sql`${job.recoveryTimeoutMs} IS NOT NULL`,
        NEVER_EXHAUSTED_JOB_KINDS.length
          ? sql`${job.kind} NOT IN (${sql.join(
              NEVER_EXHAUSTED_JOB_KINDS.map((kind) => sql`${kind}`),
              sql`, `,
            )})`
          : undefined,
        sql`coalesce(${job.lastUsefulProgressAt}, ${job.createdAt}) + ${job.recoveryTimeoutMs} * interval '1 millisecond' <= ${new Date().toISOString()}::timestamp`,
      ),
    );
}

/** Backfill (Jobs without an active member-visible Run) keeps this share of every batch. */
export const JOB_BACKFILL_SHARE = 0.2;
/** A kind's slots per fair round: 1 + log10(backlog), at most this many. */
export const JOB_MAX_KIND_WEIGHT = 8;

/** Due work the server drain may claim; parked kinds wait for their own executor. */
const drainedDue = (now: Date) =>
  and(
    due(now),
    UNDRAINED_JOB_KINDS.length
      ? sql`${job.kind} NOT IN (${sql.join(
          UNDRAINED_JOB_KINDS.map((kind) => sql`${kind}`),
          sql`, `,
        )})`
      : undefined,
  );

/**
 * The drain's fair order. Jobs of a running, member-visible Run lead; then a
 * weighted round-robin across kinds, where a kind's share of each round grows
 * with the log of its backlog (bounded by `JOB_MAX_KIND_WEIGHT`), so a flood
 * of one kind cannot starve another. Within a round the kind claimed least
 * recently goes first; only a claim is service, so invalidations and
 * enqueues leave `lastClaimedAt`. Within a kind, priority then age.
 */
const fairlyOrderedDueJobs = (now: Date, perKind?: number) => sql`
  WITH due AS (
    SELECT "Job".id, "Job".kind, "Job".priority, "Job"."updatedAt", "Job"."availableAt",
      ("Job"."runId" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "Run" r WHERE r.id = "Job"."runId" AND r.status = ${runStatus.enum.running}
          AND r."deletedAt" IS NULL AND r.purpose IN (${sql.join(
            VISIBLE_RUN_PURPOSES.map((purpose) => sql`${purpose}`),
            sql`, `,
          )}))) AS run_owned
    FROM "Job" WHERE ${drainedDue(now)}
  ), backlog AS (
    SELECT kind, count(*) AS size FROM due GROUP BY kind
  ), served AS (
    SELECT kind, max("lastClaimedAt") AS last_served FROM "Job"
    WHERE kind IN (SELECT kind FROM backlog) GROUP BY kind
  ), ranked AS (
    SELECT due.id, due.kind, due.run_owned, served.last_served,
      row_number() OVER (
        PARTITION BY due.run_owned, due.kind
        ORDER BY due.priority DESC, due."updatedAt", due."availableAt", due.id
      ) AS position,
      least(${JOB_MAX_KIND_WEIGHT}, 1 + floor(log(backlog.size::numeric))) AS weight
    FROM due JOIN backlog USING (kind) JOIN served USING (kind)
  ), candidates AS (
    -- A batch never needs more than its size from one kind and class.
    SELECT * FROM ranked ${perKind === undefined ? sql`` : sql`WHERE position <= ${perKind}`}
  ), ordered AS (
    SELECT id, kind, run_owned,
      row_number() OVER (
        PARTITION BY run_owned
        ORDER BY ceil(position / weight), last_served NULLS FIRST, kind, position
      ) AS class_position,
      row_number() OVER (
        ORDER BY run_owned DESC, ceil(position / weight), last_served NULLS FIRST, kind, position
      ) AS overall
    FROM candidates
  )`;

/**
 * One fair batch: run-owned Jobs first, but backfill keeps
 * `JOB_BACKFILL_SHARE` of the batch whenever it has due work.
 */
export async function dueJobs(db: Database, limit = JOB_DRAIN.batch) {
  await stopStalledJobs(db);
  const result = await getDb(db).execute<{
    id: string;
    kind: string;
    run_owned: boolean;
  }>(sql`${fairlyOrderedDueJobs(new Date(), limit)}
    SELECT id, kind, run_owned FROM ordered
    WHERE class_position <= ${limit} ORDER BY overall`);
  const owned = result.rows.filter((row) => row.run_owned);
  const backfill = result.rows.filter((row) => !row.run_owned);
  const reserved = Math.min(
    backfill.length,
    Math.ceil(limit * JOB_BACKFILL_SHARE),
  );
  const leading = owned.slice(0, Math.max(0, limit - reserved));
  return [...leading, ...backfill.slice(0, limit - leading.length)].map(
    ({ id, kind }) => ({ id, kind }),
  );
}

/** Visible queue positions use the drain's fair order: due Jobs ahead of each. */
export async function dueJobPositions(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const result = await getDb(db).execute<{
    id: string;
    ahead: number;
  }>(sql`${fairlyOrderedDueJobs(new Date())}
    SELECT id, (overall - 1)::int AS ahead FROM ordered
    WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
  return new Map(result.rows.map((row) => [row.id, row.ahead]));
}

export async function dueJobsAhead(db: Database, id: string) {
  return (await dueJobPositions(db, [id])).get(id) ?? 0;
}

/** Skip a busy Job immediately; a claim never waits behind another worker. */
export async function claimJob(
  db: Database,
  id: string,
  leaseMs = JOB_LEASE_MS,
): Promise<JobClaim | null> {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new Error("Job lease must be a positive finite duration");
  const now = new Date();
  return withTransactionDatabase(db, async (tx) => {
    const [available] = await getDb(tx)
      .select()
      .from(job)
      .where(and(eq(job.id, id), due(now)))
      .for("update", { skipLocked: true });
    if (!available) return null;
    // Observe durable invalidation here, in the execution's own row: a moved
    // revision starts a fresh pass (new generation, no cursor, fresh budget),
    // except that a pass in progress that finishes first keeps going.
    const [marker] = await getDb(tx)
      .select()
      .from(jobInvalidation)
      .where(eq(jobInvalidation.key, available.key));
    const moved =
      marker !== undefined &&
      marker.revision !== (available.observedRevision ?? 0);
    const restart =
      moved &&
      (available.state === "completed" ||
        available.cursor === null ||
        marker.restartsPass);
    if (restart) {
      available.attempts = 0;
      available.cursor = null;
      available.result = null;
      available.error = null;
    }
    const { retry } = jobKindPolicy(available.kind);
    const stalled =
      retry.exhaust &&
      available.recoveryTimeoutMs !== null &&
      now.getTime() -
        (available.lastUsefulProgressAt ?? available.createdAt).getTime() >=
        available.recoveryTimeoutMs;
    if (
      stalled ||
      (retry.exhaust &&
        available.recoveryTimeoutMs === null &&
        available.attempts >= available.maxAttempts)
    ) {
      await getDb(tx)
        .update(job)
        .set({
          state: "failed",
          waitReason: null,
          waitUntil: null,
          leaseToken: null,
          leaseExpiresAt: null,
          error: stalled
            ? "Job stopped after its useful-progress recovery window expired"
            : "Job exhausted attempts after interrupted execution",
          updatedAt: now,
        })
        .where(eq(job.id, id));
      return null;
    }
    const token = crypto.randomUUID();
    const expires = new Date(now.getTime() + leaseMs);
    const [claimed] = await getDb(tx)
      .update(job)
      .set({
        state: "running",
        waitReason: null,
        waitUntil: null,
        leaseToken: token,
        leaseExpiresAt: expires,
        // A never-exhausted kind counts only reported failures: a claim, or
        // reclaiming a vanished executor's expired lease, is not an attempt.
        attempts: retry.exhaust ? available.attempts + 1 : available.attempts,
        lastClaimedAt: now,
        updatedAt: now,
        ...(restart && {
          generation: sql`${job.generation} + 1`,
          cursor: null,
          result: null,
          error: null,
          observedRevision: marker.revision,
        }),
      })
      .where(eq(job.id, id))
      .returning();
    return claimed
      ? { ...claimed, leaseToken: token, leaseExpiresAt: expires }
      : null;
  });
}

/** The token, not the elapsed wall clock alone, owns publication. */
export async function renewJob(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation">,
): Promise<boolean> {
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({
      leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS),
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

/**
 * A restarting invalidation captured since this pass began supersedes the
 * page, as a generation change does. A read only: publication never writes
 * the invalidation row. A capture landing after this check is still seen,
 * because the finished pass keeps the revision it started from.
 */
async function invalidatedDuringPass(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "key" | "observedRevision">,
) {
  const [marker] = await repositoryQueries(db)
    .select()
    .from(jobInvalidation)
    .where(eq(jobInvalidation.key, claim.key));
  return (
    marker !== undefined &&
    marker.restartsPass &&
    marker.revision !== (claim.observedRevision ?? 0)
  );
}

/** The revision a finishing non-restarting pass absorbs; restarting kinds absorb none. */
async function absorbedRevision(db: RepositoryQueryInput, key: string) {
  const [marker] = await repositoryQueries(db)
    .select()
    .from(jobInvalidation)
    .where(eq(jobInvalidation.key, key));
  return marker && !marker.restartsPass ? marker.revision : undefined;
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
      : withTransactionDatabase;
  return transaction(db, async (tx) => {
    const [current] = await getDb(tx)
      .select()
      .from(job)
      .where(eq(job.id, claim.id))
      .for("update");
    if (!current || !ownsLease(current, claim)) return false;
    if (
      current.generation !== claim.generation ||
      (await invalidatedDuringPass(tx, claim))
    ) {
      await getDb(tx)
        .update(job)
        .set({
          state: "queued",
          cursor: null,
          waitReason: null,
          waitUntil: null,
          leaseToken: null,
          leaseExpiresAt: null,
          availableAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(job.id, claim.id));
      return false;
    }
    const publication = await publish?.(tx);
    const output = publication === undefined ? page.result : publication;
    // Callbacks check this running token again before committing. Complete the
    // Job after those checks and earlier hooks have recorded new work.
    await repositoryBeforeCommit(
      tx,
      async (commit) => {
        const [latest] = await commit
          .select()
          .from(job)
          .where(eq(job.id, claim.id))
          .for("update");
        if (!latest || !ownsLease(latest, claim))
          throw new JobSupersededError();
        if (
          latest.generation !== claim.generation ||
          (await invalidatedDuringPass(commit, claim))
        ) {
          await commit
            .update(job)
            .set({
              state: "queued",
              cursor: null,
              waitReason: null,
              waitUntil: null,
              leaseToken: null,
              leaseExpiresAt: null,
              availableAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(job.id, claim.id));
          return;
        }
        // A pass that does not restart absorbs captures made while it ran,
        // as the in-progress skip did: its own Run records invalidate it, so
        // rerunning on them would never settle. Its scheduled repeat covers
        // them (`scheduleRefreshFamilies`).
        const absorbed = page.done
          ? await absorbedRevision(commit, claim.key)
          : undefined;
        await commit
          .update(job)
          .set({
            ...(absorbed !== undefined && { observedRevision: absorbed }),
            state: page.done ? "completed" : "queued",
            cursor: page.cursor ?? null,
            result:
              output &&
              typeof output === "object" &&
              !Array.isArray(output) &&
              current.result &&
              typeof current.result === "object" &&
              !Array.isArray(current.result)
                ? { ...current.result, ...output }
                : (output ?? current.result),
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

export async function failJob(
  db: Database,
  claim: JobClaim,
  error: UnparsedError,
) {
  const message = JSON.stringify(describeErrorCauses(error));
  // A restarting invalidation captured during this pass outranks its
  // failure: the failed page read stale inputs, so the Job starts a fresh
  // claimable pass with a fresh budget instead of failing or backing off
  // and stranding the captured work. The prior error stays for diagnosis.
  if (await invalidatedDuringPass(db, claim)) {
    await getDb(db)
      .update(job)
      .set({
        state: "queued",
        cursor: null,
        attempts: 0,
        availableAt: new Date(),
        waitReason: null,
        waitUntil: null,
        leaseToken: null,
        leaseExpiresAt: null,
        error: message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(job.id, claim.id),
          eq(job.state, "running"),
          eq(job.leaseToken, claim.leaseToken),
        ),
      );
    return;
  }
  const { retry } = jobKindPolicy(claim.kind);
  // A never-exhausted kind counts this reported failure here, not at claim.
  const failures = retry.exhaust ? claim.attempts : claim.attempts + 1;
  await getDb(db)
    .update(job)
    .set({
      state:
        retry.exhaust &&
        claim.recoveryTimeoutMs === null &&
        claim.attempts >= claim.maxAttempts
          ? "failed"
          : "retry_wait",
      attempts: failures,
      availableAt: new Date(
        Date.now() +
          (retry.exhaust
            ? Math.min(
                JOB_RETRY_BACKOFF.maxMs,
                JOB_RETRY_BACKOFF.baseMs * 2 ** claim.attempts,
              )
            : neverExhaustedRetryDelayMs(retry, failures)),
      ),
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      error: message,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
        eq(job.generation, claim.generation),
      ),
    );
  // A failed superseded page cannot strand a newer capture behind its old lease.
  await getDb(db)
    .update(job)
    .set({
      state: "queued",
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
        sql`${job.generation} <> ${claim.generation}`,
      ),
    );
}

export async function retryJob(
  db: Database,
  id: string,
  recoveryTimeoutMs?: number,
) {
  return withTransactionDatabase(db, async (tx) => {
    const [previous] = await getDb(tx)
      .select()
      .from(job)
      .where(
        and(
          eq(job.id, id),
          inArray(job.state, ["failed", "paused", "cancelled"]),
        ),
      )
      .for("update");
    if (!previous) return null;
    if (previous.kind === "embedding.refresh") {
      // An interrupted upload may already be queued for deletion. A retry always gets a fresh physical ID.
      await getDb(tx)
        .update(job)
        .set({ key: `${previous.key}:retired:${previous.id}` })
        .where(eq(job.id, id));
      return enqueueJob(tx, {
        key: previous.key,
        kind: previous.kind,
        input: previous.input,
        subjectKind: previous.subjectKind,
        subjectId: previous.subjectId,
        maxAttempts: previous.maxAttempts,
        priority: previous.priority,
      });
    }
    const recovery = recoveryTimeoutMs ?? previous.recoveryTimeoutMs;
    const [row] = await getDb(tx)
      .update(job)
      .set({
        state: "queued",
        attempts: 0,
        recoveryTimeoutMs: recovery,
        lastUsefulProgressAt: recovery ? new Date() : null,
        generation: sql`${job.generation} + 1`,
        error: null,
        waitReason: null,
        waitUntil: null,
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(job.id, id))
      .returning();
    return row ?? null;
  });
}

/**
 * Retry now, set-based: matching Jobs become due immediately with backoff and
 * provider waits cleared; prior errors stay for diagnosis. Failed and
 * cancelled Jobs reopen with a fresh attempt budget and generation. Running
 * and member-paused Jobs are left alone.
 */
export async function retryJobsNow(db: Database, where: SQL) {
  const client = repositoryQueries(db);
  // A stopped embedding upload needs a fresh physical ID (`retryJob`).
  const embeddings = await client
    .select({ id: job.id })
    .from(job)
    .where(
      and(
        where,
        eq(job.kind, "embedding.refresh"),
        inArray(job.state, ["failed", "cancelled"]),
      ),
    );
  const retried: string[] = [];
  for (const { id } of embeddings) {
    const row = await retryJob(db, id);
    if (row) retried.push(row.id);
  }
  const now = new Date();
  const reopened = await client
    .update(job)
    .set({
      state: "queued",
      attempts: 0,
      generation: sql`CASE WHEN ${job.state} IN (${jobState.enum.failed}, ${jobState.enum.cancelled}) THEN ${job.generation} + 1 ELSE ${job.generation} END`,
      lastUsefulProgressAt: sql`CASE WHEN ${job.recoveryTimeoutMs} IS NULL THEN NULL ELSE ${now.toISOString()}::timestamp END`,
      availableAt: now,
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        where,
        inArray(job.state, ["queued", "retry_wait", "failed", "cancelled"]),
        sql`NOT (${job.kind} = 'embedding.refresh' AND ${job.state} IN (${jobState.enum.failed}, ${jobState.enum.cancelled}))`,
      ),
    )
    .returning({ id: job.id });
  return [...retried, ...reopened.map((row) => row.id)];
}

export async function cancelJob(db: RepositoryQueryInput, id: string) {
  return controlJob(db, id, "cancelled");
}

export async function pauseJob(db: RepositoryQueryInput, id: string) {
  return controlJob(db, id, "paused");
}

export async function pauseClaimedJob(
  db: Database,
  claim: JobClaim,
  error: UnparsedError,
) {
  await getDb(db)
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
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.generation, claim.generation),
        eq(job.leaseToken, claim.leaseToken),
      ),
    );
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

async function controlJob(
  db: RepositoryQueryInput,
  id: string,
  state: "paused" | "cancelled",
) {
  const [row] = await repositoryQueries(db)
    .update(job)
    .set({
      state,
      generation: sql`${job.generation} + 1`,
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.id, id),
        inArray(job.state, ["queued", "running", "retry_wait", "paused"]),
      ),
    )
    .returning();
  return row ?? null;
}

/** Routine passes can repeat completed work, but never revive a member control or exhausted failure. */
export async function repeatJob(
  db: RepositoryQueryInput,
  input: EnqueueJobInput,
  intervalMs = 0,
) {
  const row = await enqueueJob(db, input);
  if (
    row.state !== "completed" ||
    Date.now() - row.updatedAt.getTime() < intervalMs
  )
    return row;
  const [repeated] = await repositoryQueries(db)
    .update(job)
    .set({
      state: "queued",
      generation: sql`${job.generation} + 1`,
      cursor: null,
      result: null,
      attempts: 0,
      input: input.input,
      waitReason: null,
      waitUntil: null,
      availableAt: input.availableAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(job.id, row.id), eq(job.state, "completed")))
    .returning();
  return repeated ?? row;
}

/** Used by domain receipt transactions before applying externally prepared results. */
export async function assertJobClaim(
  db: RepositoryQueryInput,
  claim: JobClaim,
  lock?: "share" | "update",
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

export { JobSupersededError } from "../errors";

/**
 * Cancel every active Job matching `where` in one statement. Callers holding
 * a global lock (Run cancel holds AI admission) must never loop per row.
 */
export async function cancelJobsWhere(db: RepositoryQueryInput, where: SQL) {
  return repositoryQueries(db)
    .update(job)
    .set({
      state: "cancelled",
      generation: sql`${job.generation} + 1`,
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        where,
        inArray(job.state, ["queued", "running", "retry_wait", "paused"]),
      ),
    )
    .returning({ id: job.id });
}

/**
 * A cancelled Run stops its own Jobs. Never-exhausted work (image
 * processing) belongs to its subject, not the Run that requested it: it
 * keeps running and only loses the Run's priority.
 */
export async function cancelRunJobs(db: RepositoryQueryInput, runId: string) {
  await repositoryQueries(db)
    .update(job)
    .set({
      state: "cancelled",
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.runId, parseEntityId("run", runId)),
        inArray(job.state, ["queued", "running", "retry_wait", "paused"]),
        NEVER_EXHAUSTED_JOB_KINDS.length
          ? notInArray(job.kind, [...NEVER_EXHAUSTED_JOB_KINDS])
          : undefined,
      ),
    );
}

/** A larger member budget may bring due work forward; stopped Jobs stay stopped. */
export async function bringQueuedJobsForward(db: Database, now: Date) {
  return getDb(db)
    .update(job)
    .set({ availableAt: now, waitUntil: null, waitReason: null })
    .where(
      and(
        inArray(job.state, ["queued", "retry_wait"]),
        gt(job.availableAt, now),
      ),
    )
    .returning({ id: job.id });
}

/** Acquire before domain locks; the returned stamp commits with genuinely new work.
 * This avoids upgrading a shared ownership fence after concurrent domain writes. */
export async function lockJobProgress(
  db: RepositoryQueryInput,
  claim: JobClaim,
) {
  if (claim.recoveryTimeoutMs === null) return async () => {};
  await assertJobClaim(db, claim, "update");
  await repositoryBeforeCommit(
    db,
    (tx) => assertJobClaim(tx, claim, "update"),
    { phase: "publication" },
  );
  return async () => {
    await repositoryQueries(db)
      .update(job)
      .set({ lastUsefulProgressAt: new Date() })
      .where(
        and(
          eq(job.id, claim.id),
          eq(job.generation, claim.generation),
          eq(job.leaseToken, claim.leaseToken),
        ),
      );
  };
}
