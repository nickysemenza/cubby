/**
 * The external-claim interface: an executor outside the server drain (an
 * Apple device pull, image processing's own hand-off) holds the same Job
 * lease and settles it through the same fences. The lease token is the
 * executor's attempt id. Image processing is the one caller.
 */
import type { JobWaitReason } from "@cubby/schemas/job";
import { and, eq, gt, inArray, lte, or, sql, type SQL } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import {
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job } from "~/server/db/retained-tables";

import {
  assertJobClaim,
  claimJob,
  externalJobClaim,
  failJob,
  jobDue,
  jobRunOwned,
  publishJobPage,
  releaseJobClaim,
  type JobClaim,
} from "./queue";

export type ExternalClaim = JobClaim;
/** Who holds a lease, shown wherever the Job's waiting-on is explained. */
export type LeaseHolder = { name: string | null; deviceId: string | null };

/** Claim a due Job for `leaseMs`; its lease token becomes the executor's attempt id. */
export const claimExternal = (db: Database, id: string, leaseMs?: number) =>
  claimJob(db, id, leaseMs);

/**
 * The running claim of `key` (optionally exactly `token`). `lateAdoption`
 * also returns an expired lease no newer claim replaced, so a late result is
 * adopted rather than dropped.
 */
export const heldExternalClaim = (
  db: RepositoryQueryInput,
  key: string,
  token?: string,
  lock = false,
  options: { lateAdoption?: boolean } = {},
) => externalJobClaim(db, key, token, lock, options);

/** Throws `JobSupersededError` unless the claim still owns its Job. */
export const assertExternalClaim = (
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "leaseToken" | "generation" | "lateAdoption">,
  lock?: "update",
) => assertJobClaim(db, claim, lock);

/** Hand the claim back without spending an attempt. */
export const releaseExternalClaim = (
  db: RepositoryQueryInput,
  claim: JobClaim,
  options?: Parameters<typeof releaseJobClaim>[2],
) => releaseJobClaim(db, claim, options);

/** The attempt failed: back off by the kind's policy. */
export const failExternalClaim = (
  db: RepositoryQueryInput,
  claim: JobClaim,
  error: UnparsedError,
) => failJob(db, claim, error);

/** Settle the claim's page (and its fenced publication); false when superseded. */
export const settleExternalClaim = (
  ...args: Parameters<typeof publishJobPage>
) => publishJobPage(...args);

/** Run-owned work (an active, member-visible Run) leads external admission too. */
export const externalRunOwned = jobRunOwned;

/** The drain's due predicate, for an external executor's backlog counts. */
export const externalJobDue = jobDue;

/**
 * The Job executing an external executor's own row, joined by key so the
 * executor's candidate or attempt query reads (and row-locks) both in one
 * statement: `.innerJoin(...externalExecution.join(key))`. Callers read the
 * execution only through these fields and predicates.
 */
export const externalExecution = {
  join: (key: SQL) => [job, eq(job.key, key)] as const,
  id: job.id,
  availableAt: job.availableAt,
  /** Claimable at `now`: due, or running under a lapsed lease. `kind` narrows to one lane. */
  claimable: (now: Date, kind?: string) =>
    and(
      kind === undefined ? undefined : eq(job.kind, kind),
      or(
        and(
          inArray(job.state, ["queued", "retry_wait"]),
          lte(job.availableAt, now),
        ),
        and(eq(job.state, "running"), lte(job.leaseExpiresAt, now)),
      ),
    ),
  /**
   * Running under `claim`'s token (and its id and generation, when given).
   * `liveAt` also requires an unexpired lease; without it an expired lease no
   * newer claim replaced still belongs to the attempt (late adoption).
   */
  held: (
    claim: { id?: JobClaim["id"]; leaseToken: string; generation?: number },
    liveAt?: Date,
  ) =>
    and(
      claim.id === undefined ? undefined : eq(job.id, claim.id),
      eq(job.state, "running"),
      claim.generation === undefined
        ? undefined
        : eq(job.generation, claim.generation),
      eq(job.leaseToken, claim.leaseToken),
      liveAt === undefined ? undefined : gt(job.leaseExpiresAt, liveAt),
    ),
};

/** Record who holds a claim's lease, in the hand-off's transaction. */
export async function recordLeaseHolder(
  db: RepositoryQueryInput,
  claim: { key: string; leaseToken: string },
  holder: LeaseHolder,
) {
  await repositoryQueries(db)
    .update(job)
    .set({ leaseHolder: holder })
    .where(
      and(
        eq(job.key, claim.key),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
      ),
    );
}

/** Extend one live or late-adoptable lease while its token and generation hold. */
export async function renewExternalLease(
  db: RepositoryQueryInput,
  claim: Pick<JobClaim, "id" | "generation"> & { leaseToken: string },
  until: Date,
): Promise<Date | null> {
  const [renewed] = await repositoryQueries(db)
    .update(job)
    .set({ leaseExpiresAt: until, updatedAt: new Date() })
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.leaseToken, claim.leaseToken),
        eq(job.generation, claim.generation),
      ),
    )
    .returning({ leaseExpiresAt: job.leaseExpiresAt });
  return renewed?.leaseExpiresAt ?? null;
}

/** Re-arm several held leases of `kind` together; returns how many still held. */
export async function rearmExternalLeases(
  db: RepositoryQueryInput,
  kind: string,
  claims: readonly { key: string; leaseToken: string }[],
  until: Date,
): Promise<number> {
  if (!claims.length) return 0;
  const renewed = await repositoryQueries(db)
    .update(job)
    .set({ leaseExpiresAt: until, updatedAt: new Date() })
    .where(
      and(
        eq(job.kind, kind),
        eq(job.state, "running"),
        or(
          ...claims.map((claim) =>
            and(eq(job.key, claim.key), eq(job.leaseToken, claim.leaseToken)),
          ),
        ),
      ),
    )
    .returning({ id: job.id });
  return renewed.length;
}

/**
 * End open executions whose work became moot: completed with `result`, with
 * a fresh generation so a held claim fails its fence.
 */
export async function retireExternalJobs(
  db: RepositoryQueryInput,
  keys: readonly string[],
  result: typeof job.$inferInsert.result,
) {
  if (!keys.length) return;
  await repositoryQueries(db)
    .update(job)
    .set({
      state: "completed",
      generation: sql`${job.generation} + 1`,
      result,
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      leaseHolder: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(job.key, [...keys]),
        inArray(job.state, ["queued", "retry_wait", "running"]),
      ),
    );
}

/** Reopen finished or paused executions of work that is open again, with a fresh budget. */
export async function restartExternalJobs(
  db: RepositoryQueryInput,
  keys: readonly string[],
) {
  if (!keys.length) return;
  await repositoryQueries(db)
    .update(job)
    .set({
      state: "queued",
      attempts: 0,
      generation: sql`${job.generation} + 1`,
      availableAt: new Date(),
      waitReason: null,
      waitUntil: null,
      leaseToken: null,
      leaseExpiresAt: null,
      leaseHolder: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        inArray(job.key, [...keys]),
        inArray(job.state, ["completed", "paused"]),
      ),
    );
}

/** Queued work of `kinds` for `subject` that waits for `reason` becomes due now; backoff stays. */
export async function endExternalWaits(
  db: RepositoryQueryInput,
  subject: { kind: string; id: string },
  kinds: readonly string[],
  reason: JobWaitReason,
) {
  await repositoryQueries(db)
    .update(job)
    .set({ availableAt: new Date(), waitReason: null, waitUntil: null })
    .where(
      and(
        eq(job.subjectKind, subject.kind),
        eq(job.subjectId, subject.id),
        inArray(job.kind, [...kinds]),
        eq(job.state, "queued"),
        eq(job.waitReason, reason),
      ),
    );
}

/**
 * Whether the Job `key` is running under `token` (a correlated attempt id).
 * `live` also requires an unexpired lease; without it an expired lease no
 * newer claim replaced still belongs to the attempt.
 */
export const externalLeaseHeld = (
  key: SQL,
  token: SQL,
  { live = false }: { live?: boolean } = {},
) =>
  sql<boolean>`EXISTS (SELECT 1 FROM ${job} WHERE ${and(
    sql`${job.key} = ${key}`,
    eq(job.state, "running"),
    sql`${job.leaseToken} = ${token}`,
    live ? gt(job.leaseExpiresAt, sql`clock_timestamp()`) : undefined,
  )})`;
