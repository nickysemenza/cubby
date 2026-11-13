import type { ImageJobId } from "@cubby/schemas/identifiers";
import { eq, sql, type SQL } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { imageProcessingJob } from "~/server/db/image-processing-schema";

/** A row's execution columns, read as its lifecycle state for test assertions. */
export async function readImageExecutions(db: Database, jobId: string) {
  const rows = await getDb(db)
    .select()
    .from(imageProcessingJob)
    .where(eq(imageProcessingJob.id, jobId as ImageJobId));
  return rows.map((row) => ({
    kind: row.lane,
    state:
      row.state !== "pending"
        ? ("completed" as const)
        : row.leaseUntil
          ? ("running" as const)
          : row.failures > 0 && !row.waitReason
            ? ("retry_wait" as const)
            : ("queued" as const),
    attempts: row.failures,
    availableAt: row.runAt,
    leaseToken: row.leaseUntil ? row.attemptId : null,
    leaseExpiresAt: row.leaseUntil,
    waitReason: row.waitReason,
    error: row.lastError,
  }));
}

export const readImageExecution = async (db: Database, jobId: string) =>
  (await readImageExecutions(db, jobId))[0];

/** Put a row's execution columns where an earlier claim or failure would have left them. */
export const updateImageExecution = (
  db: Database,
  jobId: string,
  set: {
    attemptId?: string;
    runAt?: Date | SQL;
    leaseUntil?: Date | null;
    failures?: number;
    waitReason?: typeof imageProcessingJob.$inferInsert.waitReason;
  },
) =>
  getDb(db)
    .update(imageProcessingJob)
    .set(set)
    .where(eq(imageProcessingJob.id, jobId as ImageJobId));

/** Synthetic historical receipts use the same append path as production. */
export async function seedImageExecutionReceipts(
  db: Database,
  rows:
    | Array<
        { id: string; jobId: string } & Partial<
          Omit<
            import("~/server/domains/image-processing/repo/execution-receipts").ImageExecutionReceipt,
            "id" | "jobId" | "startedAt" | "completedAt"
          >
        > & { startedAt?: Date; completedAt?: Date }
      >
    | ({ id: string; jobId: string } & Partial<
        Omit<
          import("~/server/domains/image-processing/repo/execution-receipts").ImageExecutionReceipt,
          "id" | "jobId" | "startedAt" | "completedAt"
        >
      > & { startedAt?: Date; completedAt?: Date }),
) {
  const { appendExecutionReceipt } = await import("./execution-receipt-write");
  const saved = [];
  for (const { id, jobId, startedAt, completedAt, ...patch } of Array.isArray(
    rows,
  )
    ? rows
    : [rows])
    saved.push(
      await appendExecutionReceipt(db, {
        id,
        jobId,
        patch: {
          ...patch,
          ...(startedAt ? { startedAt: startedAt.toISOString() } : {}),
          ...(completedAt ? { completedAt: completedAt.toISOString() } : {}),
        },
      }),
    );
  return saved;
}

/** A synthetic executor explicitly confirms it stopped, permitting a replacement claim. */
export async function releaseImageFixture(
  db: Database,
  jobId: string,
): Promise<void> {
  const { parseEntityId } = await import("@cubby/schemas/identifiers");
  const { releaseImageProcessingLease } = await import("./image-processing");
  const [job] = await getDb(db)
    .select()
    .from(imageProcessingJob)
    .where(eq(imageProcessingJob.id, parseEntityId("imageJob", jobId)));
  if (!job?.attemptId || !job.askId)
    throw new Error("Expected a held synthetic image claim");
  await releaseImageProcessingLease(db, {
    jobId: parseEntityId("imageJob", job.askId),
    attemptId: job.attemptId,
    reason: "Synthetic executor stopped",
    event: "execution.released",
  });
}

/** Retain synthetic metering through the real external Ask settlement boundary. */
export async function seedImageAnswerCost(
  db: Database,
  input: {
    jobId: string;
    token: string;
    chargedCost: number;
    standardCost: number;
    generation?: number;
    includesJobCost?: boolean;
  },
): Promise<void> {
  const { parseEntityId } = await import("@cubby/schemas/identifiers");
  const { queueAsk, claimExternalAsk, settleExternalAsk } =
    await import("~/server/kernel/api");
  const { cloudImageAsk } =
    await import("~/server/domains/image-processing/module");
  const { productionKernel } = await import("~/server/kernel/kernel");
  const [job] = await getDb(db)
    .select()
    .from(imageProcessingJob)
    .where(eq(imageProcessingJob.id, parseEntityId("imageJob", input.jobId)));
  if (!job) throw new Error("Expected synthetic image receipt");
  const id = await queueAsk(db, cloudImageAsk, {
    receiptId: job.id,
    imageId: job.imageId,
    sourceContentHash: job.sourceContentHash,
    processorRevision: job.processorRevision,
    kind: job.kind,
    generation: input.generation ?? 0,
  });
  const claim = await claimExternalAsk(db, cloudImageAsk, {
    id,
    executor: "synthetic-meter",
    leaseMs: 60000,
  });
  if (!claim) throw new Error("Expected synthetic meter claim");
  // The historical meter names its original token, so the receipt remains joinable.
  await getDb(db).execute(
    sql`UPDATE "Ask" SET "claimToken"=${input.token}::uuid WHERE id=${id}::uuid`,
  );
  await settleExternalAsk(
    db,
    (await productionKernel()).registry,
    cloudImageAsk,
    { ...claim, token: input.token },
    {
      output: {
        jobId: parseEntityId("imageJob", id),
        attemptId: input.token,
        completedAt: new Date().toISOString(),
        outcome: { kind: job.kind, status: "skipped", reason: "no_subject" },
      },
      costMicros: Math.round(input.chargedCost * 1000000),
      raw: JSON.stringify({
        standardCostMicros: Math.round(input.standardCost * 1000000),
        includesJobCost: input.includesJobCost ?? false,
      }),
    },
    { validate: async () => true, evidence: async () => [] },
  );
}
