import type { ActivityExecutor } from "@cubby/schemas/activity";
import type { ImageId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, sql } from "drizzle-orm";

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
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";

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
      .select({ attempts: imageProcessingJob.attempts })
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
    const assigned = await tx
      .update(imageProcessingAttempt)
      .set({
        executor: input.executor,
        assignedUserId: input.userId ?? null,
        assignedConnectionId: input.connectionId ?? null,
        diagnostics: sql`coalesce(${imageProcessingAttempt.diagnostics}, '{}'::jsonb) || ${JSON.stringify(input.diagnostics ?? {})}::jsonb`,
        state: "running",
      })
      .where(
        and(
          eq(imageProcessingAttempt.id, input.attemptId),
          sql`${imageProcessingAttempt.executor} IS NULL`,
        ),
      )
      .returning({ id: imageProcessingAttempt.id });
    if (!assigned.length) return false;
    await recordImageProcessingEvent(tx, {
      jobId: input.jobId,
      eventKey: `${input.attemptId}:assigned`,
      event: "execution.assigned",
      attempt: job.attempts,
      source: input.executor.kind,
      details: input.executor,
    });
    return true;
  });
}

export async function isAssignedImageProcessingDevice(
  db: Database,
  input: { jobId: string; attemptId: string; deviceId: string; userId: string },
): Promise<boolean> {
  const [attempt] = await getDb(db)
    .select({
      executor: imageProcessingAttempt.executor,
      userId: imageProcessingAttempt.assignedUserId,
    })
    .from(imageProcessingAttempt)
    .where(
      and(
        eq(imageProcessingAttempt.id, input.attemptId),
        eq(imageProcessingAttempt.jobId, input.jobId),
      ),
    );
  return (
    attempt?.executor?.kind === "device" &&
    attempt.executor.deviceId === input.deviceId &&
    attempt.userId === input.userId
  );
}

export async function createImageProcessingSubmission(db: Database) {
  const [row] = await getDb(db)
    .insert(imageProcessingSubmission)
    .values({})
    .returning();
  if (!row) throw new Error("Image processing submission was not persisted");
  return row;
}

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
