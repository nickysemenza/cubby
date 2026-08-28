import type {
  BackgroundBatchDetail,
  BackgroundBatchJobsInput,
  BackgroundBatchJobsOut,
  BackgroundBatchProcessor,
  BackgroundBatchRef,
  BackgroundBatchSource,
  BackgroundBatchSummary,
  BackgroundJobKind,
  BackgroundJobStatus,
  BackgroundJobSummary,
} from "@cubby/schemas/background-jobs";
import { getErrorMessage } from "@cubby/shared";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { backgroundBatch, backgroundJob } from "~/server/db/schema";
import {
  countWhere,
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

/** A queue redelivery may reclaim work left running by a crashed worker. */
export const BACKGROUND_JOB_LEASE_MS = 15 * 60 * 1_000;

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

export interface StartOrReuseBackgroundWorkflowInput {
  kind: BackgroundJobKind;
  source: BackgroundBatchSource;
  dedupeKey: string;
  metadata: unknown;
  initialJobs?: CreateBackgroundJobInput[];
}

/**
 * Start one durable workflow or return its in-flight predecessor. The partial
 * unique index on `BackgroundBatch.dedupeKey` makes this safe across concurrent
 * requests; completed batches intentionally do not participate in reuse.
 */
export async function startOrReuseBackgroundWorkflow(
  db: Database,
  input: StartOrReuseBackgroundWorkflowInput,
): Promise<{ batch: BackgroundBatchRef; reused: boolean; jobIds: string[] }> {
  return await withTransaction(db, async (tx) => {
    const insertWorkflowBatch = async (): Promise<BatchRow | undefined> => {
      const [row] = await tx
        .insert(backgroundBatch)
        .values({
          kind: input.kind,
          source: input.source,
          dedupeKey: input.dedupeKey,
          metadata: input.metadata,
          status: "queued",
        })
        .onConflictDoNothing()
        .returning();
      return row;
    };
    const findActiveWorkflow = async (): Promise<BatchRow | undefined> =>
      await tx.query.backgroundBatch.findFirst({
        where: and(
          eq(backgroundBatch.dedupeKey, input.dedupeKey),
          eq(backgroundBatch.kind, input.kind),
          inArray(backgroundBatch.status, ["queued", "running"]),
          notDeleted(backgroundBatch),
        ),
      });

    let created = await insertWorkflowBatch();
    let existing: BatchRow | undefined;
    if (!created) {
      existing = await findActiveWorkflow();
      if (!existing) {
        // The conflicting partial-index row can become terminal between the
        // INSERT and this SELECT. Its unique slot is released at that point,
        // so retry the INSERT once rather than surfacing a false conflict.
        created = await insertWorkflowBatch();
        if (!created) existing = await findActiveWorkflow();
      }
    }
    if (created) {
      if (!input.initialJobs?.length) {
        return {
          batch: toBackgroundBatchRef(created),
          reused: false,
          jobIds: [],
        };
      }
      const now = new Date();
      const jobs = await tx
        .insert(backgroundJob)
        .values(
          input.initialJobs.map((job) => ({
            batchId: created.id,
            kind: job.kind,
            dedupeKey: job.dedupeKey,
            payload: job.payload,
            status: "queued" as const,
            maxAttempts: job.maxAttempts ?? 3,
            queuedAt: now,
          })),
        )
        .returning({ id: backgroundJob.id });
      await recalculateBackgroundBatchSummaryTx(tx, created.id);
      const batch = await tx.query.backgroundBatch.findFirst({
        where: eq(backgroundBatch.id, created.id),
      });
      if (!batch || jobs.length !== input.initialJobs.length) {
        throw new Error("Background workflow seed disappeared");
      }
      return {
        batch: toBackgroundBatchRef(batch),
        reused: false,
        jobIds: jobs.map((job) => job.id),
      };
    }
    if (!existing) {
      throw new Error(
        `Background workflow ${input.dedupeKey} conflicts with another active workflow`,
      );
    }
    if (
      existing.metadata &&
      typeof existing.metadata === "object" &&
      !Array.isArray(existing.metadata)
    ) {
      await tx
        .update(backgroundBatch)
        .set({ metadata: { ...existing.metadata, reused: true } })
        .where(eq(backgroundBatch.id, existing.id));
    }
    const seedDedupeKeys = input.initialJobs?.map((job) => job.dedupeKey) ?? [];
    const queuedSeeds = seedDedupeKeys.length
      ? await tx
          .select({ id: backgroundJob.id })
          .from(backgroundJob)
          .where(
            and(
              eq(backgroundJob.batchId, existing.id),
              inArray(backgroundJob.dedupeKey, seedDedupeKeys),
              eq(backgroundJob.status, "queued"),
              notDeleted(backgroundJob),
            ),
          )
          .orderBy(asc(backgroundJob.createdAt), asc(backgroundJob.id))
      : [];
    return {
      batch: toBackgroundBatchRef(existing),
      reused: true,
      jobIds: queuedSeeds.map((job) => job.id),
    };
  });
}

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
    await tx
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
      .onConflictDoNothing();

    await tx
      .update(backgroundBatch)
      .set({ lastEnqueuedAt: now })
      .where(eq(backgroundBatch.id, batchId));
    await recalculateBackgroundBatchSummaryTx(tx, batchId);
    const dedupeKeys = jobs.map((job) => job.dedupeKey);
    const queued = await tx
      .select({ id: backgroundJob.id })
      .from(backgroundJob)
      .where(
        and(
          eq(backgroundJob.batchId, batchId),
          inArray(backgroundJob.dedupeKey, dedupeKeys),
          eq(backgroundJob.status, "queued"),
          notDeleted(backgroundJob),
        ),
      )
      .orderBy(asc(backgroundJob.createdAt), asc(backgroundJob.id));
    return queued.map((row) => row.id);
  });
}

/**
 * Append a workflow page and its next coordinator atomically, so a retry never
 * observes cursor metadata ahead of the jobs that should process that page.
 */
export async function appendBackgroundJobsToWorkflow(
  db: Database,
  input: {
    batchId: string;
    children: CreateBackgroundJobInput[];
    continuation?: CreateBackgroundJobInput | null;
    metadata: unknown;
  },
): Promise<{ childJobIds: string[]; continuationJobId: string | null }> {
  return await withTransaction(db, async (tx) => {
    const now = new Date();
    const jobs = [
      ...input.children.map((job) => ({ ...job, status: "queued" as const })),
      ...(input.continuation
        ? [{ ...input.continuation, status: "pending" as const }]
        : []),
    ];
    if (jobs.length) {
      await tx
        .insert(backgroundJob)
        .values(
          jobs.map((job) => ({
            batchId: input.batchId,
            kind: job.kind,
            dedupeKey: job.dedupeKey,
            payload: job.payload,
            status: job.status,
            maxAttempts: job.maxAttempts ?? 3,
            queuedAt: job.status === "queued" ? now : null,
          })),
        )
        .onConflictDoNothing();
    }

    const currentBatch = await tx.query.backgroundBatch.findFirst({
      where: and(
        eq(backgroundBatch.id, input.batchId),
        notDeleted(backgroundBatch),
      ),
      columns: { metadata: true },
    });
    const currentMetadata = currentBatch?.metadata;
    const nextMetadata =
      currentMetadata &&
      typeof currentMetadata === "object" &&
      !Array.isArray(currentMetadata) &&
      input.metadata &&
      typeof input.metadata === "object" &&
      !Array.isArray(input.metadata)
        ? { ...currentMetadata, ...input.metadata }
        : input.metadata;

    await tx
      .update(backgroundBatch)
      .set({ metadata: nextMetadata, lastEnqueuedAt: now })
      .where(
        and(eq(backgroundBatch.id, input.batchId), notDeleted(backgroundBatch)),
      );
    await recalculateBackgroundBatchSummaryTx(tx, input.batchId);
    const childDedupeKeys = input.children.map((child) => child.dedupeKey);
    const queuedChildren = childDedupeKeys.length
      ? await tx
          .select({ id: backgroundJob.id })
          .from(backgroundJob)
          .where(
            and(
              eq(backgroundJob.batchId, input.batchId),
              inArray(backgroundJob.dedupeKey, childDedupeKeys),
              eq(backgroundJob.status, "queued"),
              notDeleted(backgroundJob),
            ),
          )
          .orderBy(asc(backgroundJob.createdAt), asc(backgroundJob.id))
      : [];
    const [pendingContinuation] = input.continuation
      ? await tx
          .select({ id: backgroundJob.id })
          .from(backgroundJob)
          .where(
            and(
              eq(backgroundJob.batchId, input.batchId),
              eq(backgroundJob.dedupeKey, input.continuation.dedupeKey),
              eq(backgroundJob.status, "pending"),
              notDeleted(backgroundJob),
            ),
          )
          .limit(1)
      : [];
    return {
      childJobIds: queuedChildren.map((row) => row.id),
      continuationJobId: pendingContinuation?.id ?? null,
    };
  });
}

/**
 * Advance one workflow continuation only after every queued/running sibling
 * has reached a terminal state. Locking the batch row makes competing terminal
 * workers observe and promote at most one pending coordinator.
 */
export async function promotePendingBackgroundWorkflowContinuation(
  db: Database,
  batchId: string,
): Promise<{ jobId: string; kind: BackgroundJobKind } | null> {
  return await withTransaction(db, async (tx) => {
    const locked = await tx.execute<{ id: string }>(sql`
      SELECT "id"::text AS id
      FROM "BackgroundBatch"
      WHERE "id" = ${batchId}
        AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (!locked.rows[0]) return null;

    const [active] = await tx
      .select({ id: backgroundJob.id })
      .from(backgroundJob)
      .where(
        and(
          eq(backgroundJob.batchId, batchId),
          inArray(backgroundJob.status, ["queued", "running"]),
          notDeleted(backgroundJob),
        ),
      )
      .limit(1);
    if (active) return null;

    const [pending] = await tx
      .select({ id: backgroundJob.id, kind: backgroundJob.kind })
      .from(backgroundJob)
      .where(
        and(
          eq(backgroundJob.batchId, batchId),
          eq(backgroundJob.status, "pending"),
          notDeleted(backgroundJob),
        ),
      )
      .orderBy(asc(backgroundJob.createdAt), asc(backgroundJob.id))
      .limit(1);
    if (!pending) return null;

    await tx
      .update(backgroundJob)
      .set({ status: "queued", queuedAt: new Date() })
      .where(
        and(
          eq(backgroundJob.id, pending.id),
          eq(backgroundJob.status, "pending"),
        ),
      );
    await recalculateBackgroundBatchSummaryTx(tx, batchId);
    return { jobId: pending.id, kind: pending.kind };
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

/** Internal workflow state lookup; does not materialize child jobs. */
export async function findLatestBackgroundWorkflow(
  db: Database,
  kind: BackgroundJobKind,
  dedupeKey: string,
): Promise<BackgroundBatchSummary | null> {
  const batch = await getDb(db).query.backgroundBatch.findFirst({
    where: and(
      eq(backgroundBatch.kind, kind),
      eq(backgroundBatch.dedupeKey, dedupeKey),
      notDeleted(backgroundBatch),
    ),
    orderBy: desc(backgroundBatch.createdAt),
  });
  return batch ? toBatchSummary(batch) : null;
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

export async function getBackgroundBatchSummary(
  db: Database,
  batchId: string,
): Promise<BackgroundBatchSummary | null> {
  const batch = await getDb(db).query.backgroundBatch.findFirst({
    where: and(eq(backgroundBatch.id, batchId), notDeleted(backgroundBatch)),
  });
  return batch ? toBatchSummary(batch) : null;
}

/**
 * Bounded so a manual retry on a very large batch cannot recreate the failure it
 * is repairing: an unbounded read here fans out to one sequential sendBatch per
 * 100 jobs inside a single invocation, which is exactly how jobs get stranded.
 * Callers redispatch a page at a time; the sweeper picks up any remainder.
 */
const MAX_REDISPATCH_JOBS = 1_000;

/** The only fields redispatch needs; it must never materialize job payloads. */
export async function getQueuedBackgroundBatchDispatch(
  db: Database,
  batchId: string,
  limit: number = MAX_REDISPATCH_JOBS,
): Promise<{ kind: BackgroundJobKind; jobIds: string[] } | null> {
  const batch = await getDb(db).query.backgroundBatch.findFirst({
    where: and(eq(backgroundBatch.id, batchId), notDeleted(backgroundBatch)),
    columns: { kind: true },
  });
  if (!batch) return null;
  const jobs = await getDb(db).query.backgroundJob.findMany({
    where: and(
      eq(backgroundJob.batchId, batchId),
      eq(backgroundJob.status, "queued"),
      notDeleted(backgroundJob),
    ),
    columns: { id: true },
    orderBy: desc(backgroundJob.createdAt),
    limit,
  });
  return { kind: batch.kind, jobIds: jobs.map((job) => job.id) };
}

export async function listBackgroundBatchJobs(
  db: Database,
  input: BackgroundBatchJobsInput,
): Promise<BackgroundBatchJobsOut> {
  const where = and(
    eq(backgroundJob.batchId, input.batchId),
    notDeleted(backgroundJob),
    input.failedOnly ? eq(backgroundJob.status, "failed") : undefined,
  );
  const [rows, totalCount] = await Promise.all([
    getDb(db).query.backgroundJob.findMany({
      where,
      orderBy: [asc(backgroundJob.createdAt), asc(backgroundJob.id)],
      limit: input.pageSize,
      offset: input.pageIndex * input.pageSize,
    }),
    countWhere(db, backgroundJob, where),
  ]);
  return {
    jobs: rows.map(toJobSummary),
    totalCount,
    pageIndex: input.pageIndex,
    pageSize: input.pageSize,
  };
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
    const reclaimBefore = new Date(now.getTime() - BACKGROUND_JOB_LEASE_MS);
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
          or(
            inArray(backgroundJob.status, ["queued", "pending"]),
            and(
              eq(backgroundJob.status, "running"),
              or(
                isNull(backgroundJob.startedAt),
                lt(backgroundJob.startedAt, reclaimBefore),
              ),
            ),
          ),
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
        durationMs: sql`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - ${backgroundJob.startedAt})) * 1000))::bigint`,
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
            ? sql`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - ${backgroundJob.startedAt})) * 1000))::bigint`
            : null,
        lastError: getErrorMessage(error),
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

/**
 * A stranded job is one Postgres still holds as work-to-do but the queue never
 * delivered: `attempts` never left 0 because no consumer ever leased it. Bulk
 * dispatch is how this happens — sendBackgroundMessages awaits sendBatch in
 * sequential chunks inside the caller's invocation, so an invocation killed
 * mid-sweep strands every remaining row without throwing anything.
 *
 * Age splits them into two populations needing OPPOSITE handling, which is why
 * both bounds exist rather than one cutoff:
 *  - recoverable (MIN..MAX): redispatch. Real work, briefly lost.
 *  - abandoned (older than MAX): a human decides. Replaying month-old refreshes
 *    costs one provider call each to discover nothing changed.
 * Without the MIN bound the sweeper would race messages still legitimately in
 * flight; without MAX it would re-drive an old backlog nobody wants paid for.
 */
export const STRANDED_JOB_MIN_AGE_MS = 10 * 60 * 1_000;
export const STRANDED_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const ageCutoff = (now: Date, ageMs: number): Date =>
  new Date(now.getTime() - ageMs);

/** Never-delivered rows inside the redispatch window, plus leases a dead worker left open. */
const recoverableStrandedWhere = (now: Date) =>
  and(
    notDeleted(backgroundJob),
    or(
      and(
        eq(backgroundJob.status, "queued"),
        eq(backgroundJob.attempts, 0),
        lt(backgroundJob.createdAt, ageCutoff(now, STRANDED_JOB_MIN_AGE_MS)),
        gte(backgroundJob.createdAt, ageCutoff(now, STRANDED_JOB_MAX_AGE_MS)),
      ),
      and(
        eq(backgroundJob.status, "running"),
        lt(backgroundJob.startedAt, ageCutoff(now, BACKGROUND_JOB_LEASE_MS)),
      ),
    ),
  );

/** Never-delivered rows too old to redispatch without an explicit decision. */
const abandonedStrandedWhere = (now: Date) =>
  and(
    eq(backgroundJob.status, "queued"),
    eq(backgroundJob.attempts, 0),
    lt(backgroundJob.createdAt, ageCutoff(now, STRANDED_JOB_MAX_AGE_MS)),
    notDeleted(backgroundJob),
  );

export interface StrandedBackgroundJobRef {
  id: string;
  batchId: string;
  kind: BackgroundJobKind;
}

/**
 * Redispatch candidates. Returns only the fields the dispatcher needs — job
 * payloads are potentially wide and never belong in a sweep.
 */
export async function findRecoverableStrandedJobs(
  db: Database,
  limit: number,
  now: Date = new Date(),
): Promise<StrandedBackgroundJobRef[]> {
  return await getDb(db).query.backgroundJob.findMany({
    where: recoverableStrandedWhere(now),
    columns: { id: true, batchId: true, kind: true },
    orderBy: asc(backgroundJob.createdAt),
    limit,
  });
}

export async function countAbandonedStrandedJobs(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  return await countWhere(db, backgroundJob, abandonedStrandedWhere(now));
}

/**
 * Cancel abandoned rows and settle their parents. `cancelled` rather than a
 * DELETE: it is an existing terminal status, keeps the history, and sidesteps
 * the BackgroundJob.batchId -> BackgroundBatch FK ordering a hard delete needs.
 * Batches must be recalculated or they keep counting these as queued forever.
 */
export async function cancelAbandonedStrandedJobs(
  db: Database,
  limit: number,
  now: Date = new Date(),
): Promise<{ cancelled: number; batchesSettled: number }> {
  return await withTransaction(db, async (tx) => {
    const targets = await tx
      .select({ id: backgroundJob.id, batchId: backgroundJob.batchId })
      .from(backgroundJob)
      .where(abandonedStrandedWhere(now))
      .orderBy(asc(backgroundJob.createdAt))
      .limit(limit);
    if (targets.length === 0) return { cancelled: 0, batchesSettled: 0 };

    await tx
      .update(backgroundJob)
      .set({ status: "cancelled", finishedAt: now })
      .where(
        inArray(
          backgroundJob.id,
          targets.map((job) => job.id),
        ),
      );

    const batchIds = [...new Set(targets.map((job) => job.batchId))];
    for (const batchId of batchIds) {
      await recalculateBackgroundBatchSummaryTx(tx, batchId);
    }
    return { cancelled: targets.length, batchesSettled: batchIds.length };
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
      COALESCE(SUM("durationMs"), 0)::bigint AS "activeDurationMs"
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
