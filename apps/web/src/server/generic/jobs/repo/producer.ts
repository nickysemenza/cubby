/**
 * The producer interface: durable intent committed with the authoritative
 * save. A queue message, app-open signal or cron only wakes the drain.
 */
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  enqueueJobInput,
  jobState,
  type EnqueueJobInput,
} from "@cubby/schemas/job";
import { generateShortcode } from "@cubby/shared";
import { and, eq, inArray, not, sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries,
  repositorySavepoint,
  repositoryTransactionDatabase,
  repositoryTransactionOn,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job, jobInvalidationCapture } from "~/server/db/retained-tables";
import {
  insertPayloadsWithIdentities,
  isEntityShortcodeCollision,
} from "~/server/entity-kernel/repo/entity-identity-writer";
import { findPgError } from "~/server/errors/db-errors";
import { findOrCreateWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { jobKindPolicy } from "../kind-policy";
import { unobservedJobInvalidation, type JobRow } from "./queue";

const rowValues = (input: EnqueueJobInput) => ({
  key: input.key,
  kind: input.kind,
  input: input.input,
  subjectKind: input.subjectKind ?? null,
  subjectId: input.subjectId ?? null,
  runId: input.runId ? parseEntityId("run", input.runId) : null,
  priority: input.priority ?? 0,
  maxAttempts:
    input.maxAttempts === undefined
      ? jobKindPolicy(input.kind).maxAttempts
      : input.maxAttempts,
  availableAt: input.availableAt ?? new Date(),
});

/**
 * Call inside the authoritative save transaction. `invalidate` starts a fresh
 * pass with new input: a running pass loses its lease, so its publication
 * fails its fence and the new pass is due at once.
 */
export async function enqueueJob(
  db: RepositoryQueryInput,
  submitted: EnqueueJobInput,
): Promise<JobRow> {
  const input = enqueueJobInput.parse(submitted);
  const values = rowValues(input);
  return repositoryTransactionOn(db, async (tx) => {
    const found = await findOrCreateWithShortcode(tx, "job", {
      where: eq(job.key, input.key),
      lock: true,
      values: () => values,
    });
    let row: JobRow = found.row;
    if (!found.created && input.invalidate) {
      const [updated] = await tx
        .update(job)
        .set({
          ...values,
          generation: sql`${job.generation} + 1`,
          state: jobState.enum.queued,
          cursor: null,
          result: null,
          attempts: 0,
          error: null,
          waitReason: null,
          waitUntil: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(job.id, row.id),
            eq(job.kind, input.kind),
            inArray(job.state, [
              "queued",
              "retry_wait",
              "running",
              "completed",
            ]),
          ),
        )
        .returning();
      if (updated) row = updated;
    }
    if (row.kind !== input.kind)
      throw new Error(
        `Job key ${input.key} belongs to ${row.kind}, not ${input.kind}`,
      );
    return row;
  });
}

/** Insert fresh keyed Jobs and identities in sets. Invalidation stays with enqueueJob. */
export async function enqueueJobs(
  db: Database,
  submitted: readonly EnqueueJobInput[],
): Promise<JobRow[]> {
  const inputs = [
    ...new Map(
      submitted.map((value) => {
        const input = enqueueJobInput.parse(value);
        return [input.key, input] as const;
      }),
    ).values(),
  ];
  if (!inputs.length) return [];
  if (inputs.some((input) => input.invalidate))
    throw new Error("Batch Job enrollment does not invalidate existing Jobs");
  return repositoryTransactionDatabase(db, async (tx) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await repositoryQueries(tx)
        .select()
        .from(job)
        .where(
          inArray(
            job.key,
            inputs.map((input) => input.key),
          ),
        )
        .orderBy(job.id)
        .for("update");
      if (
        existing.some((row) =>
          inputs.some(
            (input) => input.key === row.key && input.kind !== row.kind,
          ),
        )
      )
        throw new Error("Job key belongs to a different kind");
      const held = new Set(existing.map((row) => row.key));
      const fresh = inputs.filter((input) => !held.has(input.key));
      if (!fresh.length) return existing;
      try {
        const created = await repositorySavepoint(tx, (client) =>
          insertPayloadsWithIdentities(
            client,
            job,
            "job",
            fresh.map((input) => ({
              ...rowValues(input),
              shortcode: generateShortcode("job"),
            })),
          ),
        );
        return [...existing, ...created];
      } catch (error) {
        if (
          !isEntityShortcodeCollision(error, "Job") &&
          !(
            findPgError(error)?.code === "23505" &&
            findPgError(error)?.constraint === "Job_key_unique"
          )
        )
          throw error;
      }
    }
    throw new Error("Could not enroll Jobs after repeated key/code collisions");
  });
}

/**
 * Wake a Job in the source transaction: append an independent capture, and
 * create the Job on its first wake. Writers never update each other's capture
 * or the execution row, and a wake during a pass is never lost: the pass
 * finishes, and the unobserved capture makes the Job due again.
 */
export async function wakeJob(
  db: RepositoryQueryInput,
  input: Omit<EnqueueJobInput, "invalidate">,
) {
  await repositoryTransactionOn(db, async (tx) => {
    await repositoryQueries(tx)
      .insert(jobInvalidationCapture)
      .values({ key: input.key, capturedAt: new Date() });
    const [existing] = await repositoryQueries(tx)
      .select({ id: job.id })
      .from(job)
      .where(eq(job.key, input.key));
    if (!existing) await enqueueJob(tx, input);
  });
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
    .where(
      and(
        eq(job.id, row.id),
        eq(job.state, "completed"),
        // A wake already made it due; requeueing would only move its availability.
        not(unobservedJobInvalidation()),
      ),
    )
    .returning();
  return repeated ?? row;
}
