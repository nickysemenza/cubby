import type { ActivityExecutor } from "@cubby/schemas/activity";
import {
  executionWaitReason,
  type ExecutionWaitReason,
} from "@cubby/schemas/execution";
import type { ImageId, ImageJobId, DeviceId } from "@cubby/schemas/identifiers";
import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  getDb,
  insertAndReturn,
  unwrapDb,
  withTransaction,
  withTransactionOn,
  isTransaction,
} from "~/server/db/helpers";
import {
  imageProcessingJob,
  imageProcessingSubmission,
  imageProcessingSubmissionJob,
} from "~/server/db/image-processing-schema";
import { image } from "~/server/db/schema";
import { getDeviceParticipation } from "~/server/domains/device/repo/device-participation";
import { appendExecutionReceipt } from "~/server/domains/image-processing/repo/execution-receipt-write";
import { imageExecutionReceipts } from "~/server/domains/image-processing/repo/execution-receipts";

import { ringDeviceWorkAt } from "./image-processing-ring";

export async function recordImageProcessingEvent(
  db: Database | DrizzleTransaction,
  input: {
    jobId: ImageJobId;
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
 SELECT id, ${input.eventKey}, ${input.event}, ${input.attempt ?? null}, ${input.level ?? "info"}, ${input.source ?? "server"}, ${JSON.stringify(input.details ?? null)}::jsonb
 FROM "ImageProcessingJob" WHERE (id = ${input.jobId}::uuid OR "askId"=${input.jobId}::uuid) ON CONFLICT DO NOTHING`);
}

/**
 * An attempt exists only once something took the lease: an executor
 * (`assignImageProcessingExecutor`) or a failure that bumps the retry count.
 * The caller holds the job row lock, which serializes numbering. Returns the
 * attempt number, or null when `attemptId` already has a row.
 */
export async function appendInitialImageReceipt(
  db: Database | DrizzleTransaction,
  input: {
    jobId: ImageJobId;
    attemptId: string;
    state: "running" | "failed" | "skipped";
    executor?: ActivityExecutor;
    userId?: string;
    diagnostics?: unknown;
    result?: unknown;
    error?: string;
  },
): Promise<number | null> {
  const dbc = unwrapDb(db);
  const [previous] = await dbc
    .select({ id: imageExecutionReceipts.id })
    .from(imageExecutionReceipts)
    .where(eq(imageExecutionReceipts.id, input.attemptId));
  if (previous) return null;
  const [job] = await dbc
    .update(imageProcessingJob)
    .set({ attempts: sql`${imageProcessingJob.attempts}+1` })
    .where(
      or(
        eq(imageProcessingJob.id, input.jobId),
        eq(imageProcessingJob.askId, input.jobId),
      ),
    )
    .returning();
  if (!job) return null;
  const [source] = await dbc
    .select({
      key: image.key,
      sha256: image.sha256,
      contentType: image.contentType,
    })
    .from(image)
    .where(eq(image.id, job.imageId));
  await appendExecutionReceipt(db, {
    id: input.attemptId,
    jobId: job.id,
    patch: {
      number: job.attempts,
      submissionId: job.submissionId,
      state: input.state,
      executor: input.executor ?? null,
      assignedUserId: input.userId ?? null,
      diagnostics: {
        sourceContentHash: job.sourceContentHash,
        sourceKey: source?.key,
        processorRevision: job.processorRevision,
        contentType: source?.contentType,
        ...z.record(z.string(), z.unknown()).parse(input.diagnostics ?? {}),
      },
      result: input.result ?? null,
      error: input.error ?? null,
      completedAt: input.state === "running" ? null : new Date().toISOString(),
    },
  });
  return job.attempts;
}

export async function assignImageProcessingExecutor(
  db: Database,
  input: {
    jobId: ImageJobId;
    attemptId: string;
    executor: ActivityExecutor;
    userId?: string;
    diagnostics?: unknown;
    /** Assign inside the caller's hand-off transaction rather than a new one. */
    sharedTransaction?: boolean;
  },
): Promise<boolean> {
  const client = getDb(db);
  return withTransactionOn(
    input.sharedTransaction && isTransaction(client) ? client : db,
    async (tx) => {
      const [job] = await tx
        .select({ id: imageProcessingJob.id })
        .from(imageProcessingJob)
        .where(
          and(
            or(
              eq(imageProcessingJob.id, input.jobId),
              eq(imageProcessingJob.askId, input.jobId),
            ),
            eq(imageProcessingJob.attemptId, input.attemptId),
            eq(imageProcessingJob.state, "pending"),
            // Wall time, not now(): a device hand-off assigns inside the
            // transaction that claimed, and now() stays at its start.
            sql`${imageProcessingJob.leaseUntil} > clock_timestamp()`,
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
        const participation = await getDeviceParticipation(
          tx,
          executor.deviceId,
        );
        if (
          participation &&
          (!participation.automaticWork || participation.remotePaused)
        )
          return false;
        if (participation) executor = { ...executor, name: participation.name };
      }
      // The conflict on the lease's attempt id makes a repeated call return false.
      const number = await appendInitialImageReceipt(tx, {
        jobId: input.jobId,
        attemptId: input.attemptId,
        state: "running",
        executor,
        userId: input.userId,
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
    },
  );
}

/** Whether the attempt went to this member's device. */
export async function findImageProcessingDeviceAssignment(
  db: Database,
  input: {
    jobId: ImageJobId;
    attemptId: string;
    deviceId: DeviceId;
    userId: string;
  },
): Promise<boolean> {
  const [attempt] = await getDb(db)
    .select({
      executor: imageExecutionReceipts.executor,
      userId: imageExecutionReceipts.assignedUserId,
    })
    .from(imageExecutionReceipts)
    .where(
      and(
        eq(imageExecutionReceipts.id, input.attemptId),
        sql`EXISTS (SELECT 1 FROM "Ask" owed WHERE owed.id=${input.jobId}::uuid AND owed.input->${"input"}->>${"receiptId"}=${imageExecutionReceipts.jobId}::text)`,
      ),
    );
  return (
    attempt?.executor?.kind === "device" &&
    attempt.executor.deviceId === input.deviceId &&
    attempt.userId === input.userId
  );
}

export const createImageProcessingSubmission = (db: Database) =>
  insertAndReturn(db, imageProcessingSubmission, {});

/** Serializes membership with leasing so a reused job is never billed twice. */
export async function attachSubmissionJobs(
  db: Database,
  submissionId: string,
  ids: readonly ImageJobId[],
  existingIds: readonly ImageJobId[],
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
        : job.state === "pending"
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
): Promise<ImageJobId[]> {
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

/**
 * A typed wait (AI funding, provider capacity, a device preparing input)
 * never spends the failure budget: the lease is released with its stored wait
 * reason and the attempt is kept as released history.
 */
export async function deferImageProcessingJob(
  db: Database,
  input: {
    jobId: ImageJobId;
    attemptId: string;
    until: Date;
    reason: string;
    waitReason: ExecutionWaitReason;
  },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const rows = await tx
      .update(imageProcessingJob)
      .set({
        lastError: input.reason,
        leaseUntil: null,
        runAt: input.until,
        waitReason: input.waitReason,
      })
      .where(
        and(
          or(
            eq(imageProcessingJob.id, input.jobId),
            eq(imageProcessingJob.askId, input.jobId),
          ),
          eq(imageProcessingJob.attemptId, input.attemptId),
          eq(imageProcessingJob.state, "pending"),
          sql`${imageProcessingJob.leaseUntil} > clock_timestamp()`,
        ),
      )
      .returning({ lane: imageProcessingJob.lane });
    const [row] = rows;
    if (!row) return false;
    const { releaseExternalAsk } = await import("~/server/kernel/api");
    const found = await tx.execute<{ id: string; executor: string }>(
      sql`SELECT id,executor FROM "Ask" WHERE "claimToken"=${input.attemptId}::uuid`,
    );
    const held = found.rows[0];
    if (
      !held ||
      !(await releaseExternalAsk(
        databaseForTransaction(tx),
        { id: held.id, token: input.attemptId, executor: held.executor },
        input.until,
      ))
    )
      return false;
    // Parked device work waits out the deferral; the ring covers its end.
    if (row.lane === "device") await ringDeviceWorkAt(tx, input.until);
    const [receipt] = await tx
      .select({ id: imageExecutionReceipts.id })
      .from(imageExecutionReceipts)
      .where(eq(imageExecutionReceipts.id, input.attemptId));
    if (receipt)
      await appendExecutionReceipt(tx, {
        id: input.attemptId,
        jobId: input.jobId,
        patch: {
          state: "released",
          completedAt: new Date().toISOString(),
          error: input.reason,
        },
      });
    await recordImageProcessingEvent(tx, {
      jobId: input.jobId,
      eventKey: `${input.attemptId}:deferred`,
      event: "dispatch.deferred",
      level: "info",
      source: "server",
      details: { waitReason: input.waitReason, until: input.until },
    });
    return true;
  });
}

/**
 * A funding change ends image funding waits now; a source still without
 * funding defers the attempt again before spending.
 */
const fundingWaitingImageJobs = () =>
  and(
    eq(imageProcessingJob.state, "pending"),
    eq(
      imageProcessingJob.waitReason,
      executionWaitReason.enum.ai_funding_window,
    ),
    sql`${imageProcessingJob.runAt} > now()`,
  );

export async function countFundingWaitingImageJobs(db: Database) {
  const [row] = await getDb(db)
    .select({ n: count() })
    .from(imageProcessingJob)
    .where(fundingWaitingImageJobs());
  return row?.n ?? 0;
}

export async function wakeFundingWaitingImageJobs(db: Database) {
  const woken = await getDb(db)
    .update(imageProcessingJob)
    .set({ runAt: sql`now()` })
    .where(fundingWaitingImageJobs())
    .returning({ id: imageProcessingJob.id });
  return woken.length;
}
