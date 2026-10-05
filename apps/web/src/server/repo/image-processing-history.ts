import type { ActivityExecutor } from "@cubby/schemas/activity";
import type { ImageId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  imageProcessingAttempt,
  imageProcessingJob,
  imageProcessingSubmission,
  imageProcessingSubmissionJob,
} from "~/server/db/image-processing-schema";
import { image } from "~/server/db/schema";
import {
  getDb,
  insertAndReturn,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { getDeviceParticipation } from "~/server/repo/device-participation";

export async function recordImageProcessingEvent(
  db: Database | DrizzleTransaction,
  input: {
    jobId: string;
    eventKey: string;
    event: string;
    attempt?: number;
    level?: "info" | "error" | "debug";
    source?: "server" | "cloud" | "device";
    details?: unknown;
  },
) {
  const dbc = unwrapDb(db);
  await dbc.execute(sql`INSERT INTO "ImageProcessingEvent" ("jobId", "eventKey", event, attempt, level, source, details)
 SELECT ${input.jobId}::uuid, ${input.eventKey}, ${input.event}, ${input.attempt ?? null}, ${input.level ?? "info"}, ${input.source ?? "server"}, ${JSON.stringify(input.details ?? null)}::jsonb
 FROM "ImageProcessingJob" WHERE id = ${input.jobId}::uuid ON CONFLICT DO NOTHING`);
}

/**
 * An attempt exists only once something took the lease: an executor
 * (`assignImageProcessingExecutor`) or a failure that bumps the retry count.
 * The caller holds the job row lock, which serializes numbering. Returns the
 * attempt number, or null when `attemptId` already has a row.
 */
export async function insertImageProcessingAttempt(
  db: Database | DrizzleTransaction,
  input: {
    jobId: string;
    attemptId: string;
    state: "running" | "failed";
    executor?: ActivityExecutor;
    userId?: string;
    connectionId?: string;
    diagnostics?: unknown;
    result?: unknown;
    error?: string;
  },
): Promise<number | null> {
  const dbc = unwrapDb(db);
  const inserted = await dbc.execute(sql`
    INSERT INTO "ImageProcessingAttempt"
      (id, "jobId", number, "submissionId", state, executor, "assignedUserId",
       "assignedConnectionId", diagnostics, result, error, "completedAt")
    SELECT ${input.attemptId}::uuid, j.id,
      coalesce((SELECT max(a.number) FROM "ImageProcessingAttempt" a WHERE a."jobId" = j.id), 0) + 1,
      j."submissionId", ${input.state},
      ${input.executor ? JSON.stringify(input.executor) : null}::jsonb,
      ${input.userId ?? null}, ${input.connectionId ?? null},
      jsonb_build_object(
        'sourceContentHash', j."sourceContentHash",
        'sourceKey', i.key,
        'inputAvailability', 'recorded original',
        'processorRevision', j."processorRevision",
        'contentType', i."contentType"
      ) || ${JSON.stringify(input.diagnostics ?? {})}::jsonb,
      ${input.result === undefined ? null : JSON.stringify(input.result)}::jsonb,
      ${input.error ?? null},
      ${input.state === "running" ? null : sql`now()`}
    FROM "ImageProcessingJob" j
    LEFT JOIN "Image" i ON i.id = j."imageId"
    WHERE j.id = ${input.jobId}::uuid
    ON CONFLICT DO NOTHING
    RETURNING number`);
  const row = z.array(z.object({ number: z.number() })).parse(inserted.rows)[0];
  if (!row) return null;
  await dbc.execute(
    sql`UPDATE "ImageProcessingJob" SET attempts = attempts + 1 WHERE id = ${input.jobId}::uuid`,
  );
  return row.number;
}

export async function assignImageProcessingExecutor(
  db: Database,
  input: {
    jobId: string;
    attemptId: string;
    executor: ActivityExecutor;
    userId?: string;
    connectionId?: string;
    diagnostics?: unknown;
  },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const [job] = await tx
      .select({ id: imageProcessingJob.id })
      .from(imageProcessingJob)
      .where(
        and(
          eq(imageProcessingJob.id, input.jobId),
          eq(imageProcessingJob.attemptId, input.attemptId),
          eq(imageProcessingJob.state, "leased"),
          sql`${imageProcessingJob.leaseExpiresAt} > now()`,
        ),
      )
      .for("update");
    if (!job) return false;
    // Authoritative re-check: `dispatch()`'s socket-attachment cache can be up
    // to `PARTICIPATION_TTL_MS` stale, so a device that flipped `remotePaused`
    // or `automaticWork` off between hello and this assignment must still be
    // refused here, inside the transaction that grants the assignment.
    let executor = input.executor;
    if (executor.kind === "device" && executor.deviceId) {
      const participation = await getDeviceParticipation(tx, executor.deviceId);
      if (
        participation &&
        (!participation.automaticWork || participation.remotePaused)
      )
        return false;
      if (participation) executor = { ...executor, name: participation.name };
    }
    // The conflict on the lease's attempt id makes a repeated call return false.
    const number = await insertImageProcessingAttempt(tx, {
      jobId: input.jobId,
      attemptId: input.attemptId,
      state: "running",
      executor,
      userId: input.userId,
      connectionId: input.connectionId,
      diagnostics: input.diagnostics,
    });
    if (number === null) return false;
    await recordImageProcessingEvent(tx, {
      jobId: input.jobId,
      eventKey: `${input.attemptId}:assigned`,
      event: "execution.assigned",
      attempt: number,
      source: executor.kind,
      details: executor,
    });
    return true;
  });
}

/** The attempt's assignment when it went to this member's device, else null. */
export async function findImageProcessingDeviceAssignment(
  db: Database,
  input: { jobId: string; attemptId: string; deviceId: string; userId: string },
): Promise<{ connectionId: string | null } | null> {
  const [attempt] = await getDb(db)
    .select({
      executor: imageProcessingAttempt.executor,
      userId: imageProcessingAttempt.assignedUserId,
      connectionId: imageProcessingAttempt.assignedConnectionId,
    })
    .from(imageProcessingAttempt)
    .where(
      and(
        eq(imageProcessingAttempt.id, input.attemptId),
        eq(imageProcessingAttempt.jobId, input.jobId),
      ),
    );
  return attempt?.executor?.kind === "device" &&
    attempt.executor.deviceId === input.deviceId &&
    attempt.userId === input.userId
    ? { connectionId: attempt.connectionId }
    : null;
}

export const createImageProcessingSubmission = (db: Database) =>
  insertAndReturn(db, imageProcessingSubmission, {});

/** Serializes membership with leasing so a reused job is never billed twice. */
export async function attachSubmissionJobs(
  db: Database,
  submissionId: string,
  ids: readonly string[],
  existingIds: readonly string[],
) {
  if (!ids.length) return;
  await withTransaction(db, async (tx) => {
    const jobs = await tx
      .select()
      .from(imageProcessingJob)
      .where(inArray(imageProcessingJob.id, [...ids]))
      .orderBy(imageProcessingJob.id)
      .for("update");
    for (const job of jobs) {
      const disposition = !existingIds.includes(job.id)
        ? "new"
        : ["pending", "leased", "waiting_for_device"].includes(job.state)
          ? "running"
          : "reused";
      await tx
        .insert(imageProcessingSubmissionJob)
        .values({
          submissionId,
          jobId: job.id,
          disposition,
          baselineAttempts: job.attempts,
        })
        .onConflictDoNothing();
      if (disposition === "new")
        await tx
          .update(imageProcessingJob)
          .set({ submissionId })
          .where(eq(imageProcessingJob.id, job.id));
    }
  });
}

export async function lockImageProcessingSubmissionSource(
  db: Database,
  imageId: ImageId,
): Promise<string[]> {
  await getDb(db)
    .select({ id: image.id })
    .from(image)
    .where(eq(image.id, imageId))
    .for("update");
  return (
    await getDb(db)
      .select({ id: imageProcessingJob.id })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.imageId, imageId))
  ).map((row) => row.id);
}
