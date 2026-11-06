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
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries,
  repositoryTransactionDatabase,
  repositoryTransactionOn,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { job } from "~/server/db/retained-tables";

import { jobKindPolicy } from "../kind-policy";
import type { JobRow } from "./queue";

const rowValues = (input: EnqueueJobInput) => ({
  key: input.key,
  kind: input.kind,
  input: input.input,
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
    const held = () =>
      tx.select().from(job).where(eq(job.key, input.key)).for("update");
    const [existing] = await held();
    const [inserted] = existing
      ? []
      : await tx
          .insert(job)
          .values(values)
          .onConflictDoNothing({ target: job.key })
          .returning();
    const current = existing ?? inserted ?? (await held())[0];
    if (!current) throw new Error(`Job key ${input.key} could not be enrolled`);
    let row: JobRow = current;
    if (!inserted && input.invalidate) {
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
    await repositoryQueries(tx)
      .insert(job)
      .values(
        [...inputs]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((input) => rowValues(input)),
      )
      .onConflictDoNothing({ target: job.key });
    const rows = await repositoryQueries(tx)
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
      rows.some((row) =>
        inputs.some(
          (input) => input.key === row.key && input.kind !== row.kind,
        ),
      )
    )
      throw new Error("Job key belongs to a different kind");
    return rows;
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
    .where(and(eq(job.id, row.id), eq(job.state, "completed")))
    .returning();
  return repeated ?? row;
}
