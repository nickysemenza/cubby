import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  jobState,
  enqueueJobInput,
  jobPage,
  type EnqueueJobInput,
  type JobPage,
} from "@cubby/schemas/job";
import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";

import { describeErrorCauses } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import {
  repositoryBeforeCommit,
  repositoryQueries,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job } from "~/server/db/retained-tables";

import { JobSupersededError } from "../errors";

const LEASE_MS = 5 * 60_000;
export type JobRow = typeof job.$inferSelect;
export type JobClaim = JobRow & { leaseToken: string; leaseExpiresAt: Date };

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
    runId: input.runId ? parseEntityId("run", input.runId) : null,
    priority: input.priority ?? 0,
    maxAttempts: input.maxAttempts ?? 3,
    availableAt: input.availableAt ?? new Date(),
  };
  const insertion = client.insert(job).values(values);
  const [created] = input.invalidate
    ? await insertion
        .onConflictDoUpdate({
          target: job.key,
          set: {
            ...values,
            generation: sql`${job.generation} + 1`,
            state: sql`CASE WHEN ${job.state}=${jobState.enum.running} THEN ${jobState.enum.running} ELSE ${jobState.enum.queued} END`,
            cursor: null,
            result: null,
            attempts: 0,
            error: null,
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

const due = (now: Date) =>
  or(
    and(
      inArray(job.state, ["queued", "retry_wait"]),
      lte(job.availableAt, now),
    ),
    and(eq(job.state, "running"), lte(job.leaseExpiresAt, now)),
  );

export async function dueJobs(db: Database, limit = 25) {
  return getDb(db)
    .select({ id: job.id, kind: job.kind })
    .from(job)
    .where(due(new Date()))
    .orderBy(
      desc(job.priority),
      asc(job.updatedAt),
      asc(job.availableAt),
      asc(job.id),
    )
    .limit(limit);
}

/** Skip a busy Job immediately; a claim never waits behind another worker. */
export async function claimJob(
  db: Database,
  id: string,
  leaseMs = LEASE_MS,
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
    if (available.attempts >= available.maxAttempts) {
      await getDb(tx)
        .update(job)
        .set({
          state: "failed",
          leaseToken: null,
          leaseExpiresAt: null,
          error: "Job exhausted attempts after interrupted execution",
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
        leaseToken: token,
        leaseExpiresAt: expires,
        attempts: available.attempts + 1,
        updatedAt: now,
      })
      .where(eq(job.id, id))
      .returning();
    return claimed
      ? { ...claimed, leaseToken: token, leaseExpiresAt: expires }
      : null;
  });
}

/** The token, not the elapsed wall clock alone, owns publication. */
export async function renewJob(db: Database, claim: JobClaim) {
  const [row] = await getDb(db)
    .update(job)
    .set({
      leaseExpiresAt: new Date(Date.now() + LEASE_MS),
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

/** Preparation/provider work precedes this short transaction; publish is DB-only. */
export async function publishJobPage(
  db: Database,
  claim: JobClaim,
  submitted: JobPage,
  publish?: (tx: Database) => Promise<void | JobPage["result"]>,
): Promise<boolean> {
  const page = jobPage.parse(submitted);
  return withTransactionDatabase(db, async (tx) => {
    const [current] = await getDb(tx)
      .select()
      .from(job)
      .where(eq(job.id, claim.id))
      .for("update");
    if (
      !current ||
      current.state !== "running" ||
      current.leaseToken !== claim.leaseToken ||
      !current.leaseExpiresAt ||
      current.leaseExpiresAt.getTime() <= Date.now()
    )
      return false;
    if (current.generation !== claim.generation) {
      await getDb(tx)
        .update(job)
        .set({
          state: "queued",
          cursor: null,
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
        if (
          !latest ||
          latest.state !== "running" ||
          latest.leaseToken !== claim.leaseToken ||
          !latest.leaseExpiresAt ||
          latest.leaseExpiresAt.getTime() <= Date.now()
        )
          throw new JobSupersededError();
        if (latest.generation !== claim.generation) {
          await commit
            .update(job)
            .set({
              state: "queued",
              cursor: null,
              leaseToken: null,
              leaseExpiresAt: null,
              availableAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(job.id, claim.id));
          return;
        }
        await commit
          .update(job)
          .set({
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
            availableAt: page.availableAt ?? new Date(),
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
  await getDb(db)
    .update(job)
    .set({
      state: claim.attempts >= claim.maxAttempts ? "failed" : "retry_wait",
      availableAt: new Date(
        Date.now() + Math.min(60_000, 1_000 * 2 ** claim.attempts),
      ),
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

export async function retryJob(db: Database, id: string) {
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
        maxAttempts: previous.maxAttempts,
        priority: previous.priority,
      });
    }
    const [row] = await getDb(tx)
      .update(job)
      .set({
        state: "queued",
        attempts: 0,
        generation: sql`${job.generation} + 1`,
        error: null,
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

/** Companion receipts use the exact universal claim that authorized their capability. */
export async function externalJobClaim(
  db: RepositoryQueryInput,
  key: string,
  token?: string,
  lock = false,
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
  return row?.leaseToken &&
    row.leaseExpiresAt &&
    row.leaseExpiresAt.getTime() > Date.now()
    ? { ...row, leaseToken: row.leaseToken, leaseExpiresAt: row.leaseExpiresAt }
    : null;
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
  lock = false,
) {
  const query = repositoryQueries(db)
    .select()
    .from(job)
    .where(
      and(
        eq(job.id, claim.id),
        eq(job.state, "running"),
        eq(job.generation, claim.generation),
        eq(job.leaseToken, claim.leaseToken),
      ),
    );
  const [current] = await (lock ? query.for("update") : query);
  if (
    !current?.leaseExpiresAt ||
    current.leaseExpiresAt.getTime() <= Date.now()
  )
    throw new JobSupersededError();
}

export { JobSupersededError } from "../errors";

export async function cancelRunJobs(db: RepositoryQueryInput, runId: string) {
  await repositoryQueries(db)
    .update(job)
    .set({
      state: "cancelled",
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(job.runId, parseEntityId("run", runId)),
        inArray(job.state, ["queued", "running", "retry_wait", "paused"]),
      ),
    );
}

/** A larger member budget may bring due work forward; stopped Jobs stay stopped. */
export async function bringQueuedJobsForward(db: Database, now: Date) {
  return getDb(db)
    .update(job)
    .set({ availableAt: now })
    .where(
      and(
        inArray(job.state, ["queued", "retry_wait"]),
        gt(job.availableAt, now),
      ),
    )
    .returning({ id: job.id });
}
