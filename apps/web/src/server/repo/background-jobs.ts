import type {
  BackgroundBatchDetail,
  BackgroundBatchProcessor,
  BackgroundBatchRef,
  BackgroundBatchSource,
  BackgroundBatchSummary,
  BackgroundJobKind,
  BackgroundJobStatus,
  BackgroundJobSummary,
} from "@cubby/schemas/background-jobs";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import { backgroundBatch, backgroundJob } from "~/server/db/schema";
import {
  getDb,
  insertAndReturn,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";

export interface CreateBackgroundJobInput {
  kind: BackgroundJobKind;
  dedupeKey: string;
  payload: unknown;
  maxAttempts?: number;
}

interface CreateBackgroundBatchInput {
  kind: BackgroundJobKind;
  source: BackgroundBatchSource;
  metadata?: unknown;
  jobs: CreateBackgroundJobInput[];
}

type BatchRow = typeof backgroundBatch.$inferSelect;
type JobRow = typeof backgroundJob.$inferSelect;

const coerceDate = (value: Date | string | null): Date | null => {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
};

const normalizeBatchProcessor = (
  value: BackgroundBatchProcessor | null,
): BackgroundBatchProcessor => {
  return value === "queue" ? "queue" : "inline";
};

const toBatchSummary = (row: BatchRow): BackgroundBatchSummary => ({
  id: row.id,
  kind: row.kind,
  source: row.source,
  processor: normalizeBatchProcessor(row.processor),
  status: row.status,
  totalJobs: row.totalJobs,
  queuedJobs: row.queuedJobs,
  runningJobs: row.runningJobs,
  succeededJobs: row.succeededJobs,
  failedJobs: row.failedJobs,
  skippedJobs: row.skippedJobs,
  cancelledJobs: row.cancelledJobs,
  firstEnqueuedAt: row.firstEnqueuedAt,
  lastEnqueuedAt: row.lastEnqueuedAt,
  firstJobStartedAt: row.firstJobStartedAt,
  lastJobFinishedAt: row.lastJobFinishedAt,
  processingDurationMs: row.processingDurationMs,
  wallDurationMs: row.wallDurationMs,
  activeDurationMs: row.activeDurationMs,
  metadata: row.metadata,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const toBackgroundBatchRef = (
  batch: BackgroundBatchSummary | BackgroundBatchDetail,
): BackgroundBatchRef => ({
  id: batch.id,
  kind: batch.kind,
  source: batch.source,
  processor: batch.processor,
  status: batch.status,
  totalJobs: batch.totalJobs,
});

const toJobSummary = (row: JobRow): BackgroundJobSummary => ({
  id: row.id,
  batchId: row.batchId,
  kind: row.kind,
  dedupeKey: row.dedupeKey,
  status: row.status,
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  queuedAt: row.queuedAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  durationMs: row.durationMs,
  lastError: row.lastError,
  payload: row.payload,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export async function createBackgroundBatchWithJobs(
  db: Database,
  input: CreateBackgroundBatchInput,
): Promise<{ batchId: string; jobIds: string[] }> {
  return await withTransaction(db, async (tx) => {
    const now = new Date();
    const batch = await insertAndReturn(tx, backgroundBatch, {
      kind: input.kind,
      source: input.source,
      metadata: input.metadata ?? null,
      status: input.jobs.length > 0 ? "queued" : "succeeded",
      firstEnqueuedAt: input.jobs.length > 0 ? now : null,
      lastEnqueuedAt: input.jobs.length > 0 ? now : null,
    });

    if (input.jobs.length === 0) {
      return { batchId: batch.id, jobIds: [] };
    }

    const inserted = await tx
      .insert(backgroundJob)
      .values(
        input.jobs.map((job) => ({
          batchId: batch.id,
          kind: job.kind,
          dedupeKey: job.dedupeKey,
          payload: job.payload,
          status: "queued" as const,
          maxAttempts: job.maxAttempts ?? 3,
          queuedAt: now,
        })),
      )
      .returning({ id: backgroundJob.id });

    await recalculateBackgroundBatchSummaryTx(tx, batch.id);
    return { batchId: batch.id, jobIds: inserted.map((row) => row.id) };
  });
}

export async function addBackgroundJobsToBatch(
  db: Database,
  batchId: string,
  jobs: CreateBackgroundJobInput[],
): Promise<string[]> {
  if (jobs.length === 0) return [];
  return await withTransaction(db, async (tx) => {
    const now = new Date();
    const inserted = await tx
      .insert(backgroundJob)
      .values(
        jobs.map((job) => ({
          batchId,
          kind: job.kind,
          dedupeKey: job.dedupeKey,
          payload: job.payload,
          status: "queued" as const,
          maxAttempts: job.maxAttempts ?? 3,
          queuedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: backgroundJob.id });

    await tx
      .update(backgroundBatch)
      .set({ lastEnqueuedAt: now })
      .where(eq(backgroundBatch.id, batchId));
    await recalculateBackgroundBatchSummaryTx(tx, batchId);
    return inserted.map((row) => row.id);
  });
}

export async function setBackgroundBatchProcessor(
  db: Database,
  batchId: string,
  processor: BackgroundBatchProcessor,
): Promise<void> {
  await getDb(db)
    .update(backgroundBatch)
    .set({ processor })
    .where(eq(backgroundBatch.id, batchId));
}

export async function listBackgroundBatches(
  db: Database,
  limit: number,
): Promise<BackgroundBatchSummary[]> {
  const rows = await getDb(db).query.backgroundBatch.findMany({
    where: notDeleted(backgroundBatch),
    orderBy: desc(backgroundBatch.createdAt),
    limit,
  });
  return rows.map(toBatchSummary);
}

export async function getBackgroundBatchDetail(
  db: Database,
  batchId: string,
): Promise<BackgroundBatchDetail | null> {
  const batch = await getDb(db).query.backgroundBatch.findFirst({
    where: and(eq(backgroundBatch.id, batchId), notDeleted(backgroundBatch)),
  });
  if (!batch) return null;
  const jobs = await getDb(db).query.backgroundJob.findMany({
    where: and(eq(backgroundJob.batchId, batchId), notDeleted(backgroundJob)),
    orderBy: desc(backgroundJob.createdAt),
  });
  return { ...toBatchSummary(batch), jobs: jobs.map(toJobSummary) };
}

export async function getBackgroundJob(
  db: Database,
  jobId: string,
): Promise<BackgroundJobSummary | null> {
  const row = await getDb(db).query.backgroundJob.findFirst({
    where: and(eq(backgroundJob.id, jobId), notDeleted(backgroundJob)),
  });
  return row ? toJobSummary(row) : null;
}

export async function findQueuedBackgroundJobs(
  db: Database,
  limit: number,
  kinds?: BackgroundJobKind[],
): Promise<BackgroundJobSummary[]> {
  const kindFilter = kinds?.length
    ? inArray(backgroundJob.kind, kinds)
    : undefined;
  const rows = await getDb(db).query.backgroundJob.findMany({
    where: and(
      eq(backgroundJob.status, "queued"),
      notDeleted(backgroundJob),
      kindFilter,
    ),
    orderBy: backgroundJob.createdAt,
    limit,
  });
  return rows.map(toJobSummary);
}

export async function markBackgroundJobRunning(
  db: Database,
  jobId: string,
): Promise<BackgroundJobSummary | null> {
  return await withTransaction(db, async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(backgroundJob)
      .set({
        status: "running",
        startedAt: now,
        finishedAt: null,
        durationMs: null,
        lastError: null,
        attempts: sql`${backgroundJob.attempts} + 1`,
      })
      .where(
        and(
          eq(backgroundJob.id, jobId),
          inArray(backgroundJob.status, ["queued", "pending"]),
          notDeleted(backgroundJob),
        ),
      )
      .returning();
    if (!row) return null;
    await recalculateBackgroundBatchSummaryTx(tx, row.batchId);
    return toJobSummary(row);
  });
}

export async function finishBackgroundJob(
  db: Database,
  jobId: string,
  status: Extract<BackgroundJobStatus, "succeeded" | "skipped">,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(backgroundJob)
      .set({
        status,
        finishedAt: now,
        durationMs: sql`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - ${backgroundJob.startedAt})) * 1000))::int`,
      })
      .where(eq(backgroundJob.id, jobId))
      .returning({ batchId: backgroundJob.batchId });
    if (row) await recalculateBackgroundBatchSummaryTx(tx, row.batchId);
  });
}

export async function failOrRetryBackgroundJob(
  db: Database,
  jobId: string,
  error: unknown,
): Promise<"retry" | "failed"> {
  return await withTransaction(db, async (tx) => {
    const now = new Date();
    const [job] = await tx
      .select({
        batchId: backgroundJob.batchId,
        attempts: backgroundJob.attempts,
        maxAttempts: backgroundJob.maxAttempts,
      })
      .from(backgroundJob)
      .where(and(eq(backgroundJob.id, jobId), notDeleted(backgroundJob)))
      .limit(1);
    if (!job) return "failed";

    const nextStatus = job.attempts >= job.maxAttempts ? "failed" : "queued";
    await tx
      .update(backgroundJob)
      .set({
        status: nextStatus,
        finishedAt: nextStatus === "failed" ? now : null,
        durationMs:
          nextStatus === "failed"
            ? sql`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - ${backgroundJob.startedAt})) * 1000))::int`
            : null,
        lastError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(backgroundJob.id, jobId));
    await recalculateBackgroundBatchSummaryTx(tx, job.batchId);
    return nextStatus === "failed" ? "failed" : "retry";
  });
}

export async function cancelQueuedJobsForBatch(
  db: Database,
  batchId: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx
      .update(backgroundJob)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(
        and(
          eq(backgroundJob.batchId, batchId),
          inArray(backgroundJob.status, ["queued", "pending"]),
          notDeleted(backgroundJob),
        ),
      );
    await recalculateBackgroundBatchSummaryTx(tx, batchId);
  });
}

export async function retryFailedJobsForBatch(
  db: Database,
  batchId: string,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx
      .update(backgroundJob)
      .set({
        status: "queued",
        queuedAt: new Date(),
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        lastError: null,
      })
      .where(
        and(
          eq(backgroundJob.batchId, batchId),
          eq(backgroundJob.status, "failed"),
          notDeleted(backgroundJob),
        ),
      );
    await recalculateBackgroundBatchSummaryTx(tx, batchId);
  });
}

export async function retryBackgroundJob(
  db: Database,
  jobId: string,
): Promise<string | null> {
  return await withTransaction(db, async (tx) => {
    const [row] = await tx
      .update(backgroundJob)
      .set({
        status: "queued",
        queuedAt: new Date(),
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        lastError: null,
      })
      .where(
        and(
          eq(backgroundJob.id, jobId),
          eq(backgroundJob.status, "failed"),
          notDeleted(backgroundJob),
        ),
      )
      .returning({ batchId: backgroundJob.batchId });
    if (row) await recalculateBackgroundBatchSummaryTx(tx, row.batchId);
    return row?.batchId ?? null;
  });
}

async function recalculateBackgroundBatchSummaryTx(
  tx: DrizzleTransaction,
  batchId: string,
): Promise<void> {
  const result = await tx.execute<{
    total: number | string;
    queued: number | string;
    running: number | string;
    succeeded: number | string;
    failed: number | string;
    skipped: number | string;
    cancelled: number | string;
    firstEnqueuedAt: Date | null;
    lastEnqueuedAt: Date | null;
    firstJobStartedAt: Date | null;
    lastJobFinishedAt: Date | null;
    activeDurationMs: number | string | null;
  }>(sql`
    SELECT
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (WHERE "status" IN ('queued', 'pending'))::int AS "queued",
      COUNT(*) FILTER (WHERE "status" = 'running')::int AS "running",
      COUNT(*) FILTER (WHERE "status" = 'succeeded')::int AS "succeeded",
      COUNT(*) FILTER (WHERE "status" = 'failed')::int AS "failed",
      COUNT(*) FILTER (WHERE "status" = 'skipped')::int AS "skipped",
      COUNT(*) FILTER (WHERE "status" = 'cancelled')::int AS "cancelled",
      MIN("queuedAt") AS "firstEnqueuedAt",
      MAX("queuedAt") AS "lastEnqueuedAt",
      MIN("startedAt") AS "firstJobStartedAt",
      MAX("finishedAt") AS "lastJobFinishedAt",
      COALESCE(SUM("durationMs"), 0)::int AS "activeDurationMs"
    FROM "BackgroundJob"
    WHERE "batchId" = ${batchId}
      AND "deletedAt" IS NULL
  `);
  const row = result.rows[0];
  if (!row) return;

  const total = Number(row.total);
  const queued = Number(row.queued);
  const running = Number(row.running);
  const succeeded = Number(row.succeeded);
  const failed = Number(row.failed);
  const skipped = Number(row.skipped);
  const cancelled = Number(row.cancelled);
  const terminal = succeeded + failed + skipped + cancelled;
  const status =
    cancelled === total && total > 0
      ? "cancelled"
      : failed > 0 && terminal === total
        ? succeeded + skipped > 0
          ? "partial"
          : "failed"
        : terminal === total
          ? "succeeded"
          : running > 0
            ? "running"
            : "queued";
  const firstEnqueuedAt = coerceDate(row.firstEnqueuedAt);
  const lastEnqueuedAt = coerceDate(row.lastEnqueuedAt);
  const firstJobStartedAt = coerceDate(row.firstJobStartedAt);
  const lastJobFinishedAt = coerceDate(row.lastJobFinishedAt);
  const processingDurationMs =
    firstJobStartedAt && lastJobFinishedAt
      ? Math.max(0, lastJobFinishedAt.getTime() - firstJobStartedAt.getTime())
      : null;
  const wallDurationMs =
    firstEnqueuedAt && lastJobFinishedAt
      ? Math.max(0, lastJobFinishedAt.getTime() - firstEnqueuedAt.getTime())
      : null;

  await tx
    .update(backgroundBatch)
    .set({
      status,
      totalJobs: total,
      queuedJobs: queued,
      runningJobs: running,
      succeededJobs: succeeded,
      failedJobs: failed,
      skippedJobs: skipped,
      cancelledJobs: cancelled,
      firstEnqueuedAt,
      lastEnqueuedAt,
      firstJobStartedAt,
      lastJobFinishedAt,
      processingDurationMs,
      wallDurationMs,
      activeDurationMs: Number(row.activeDurationMs ?? 0),
    })
    .where(eq(backgroundBatch.id, batchId));
}
