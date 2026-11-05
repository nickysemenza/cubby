import type { ImageJobId } from "@cubby/schemas/identifiers";
import { eq, type SQL } from "drizzle-orm";

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
