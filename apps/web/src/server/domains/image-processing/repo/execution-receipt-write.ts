import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import {
  imageProcessingEvent,
  imageProcessingJob,
} from "~/server/db/image-processing-schema";
import {
  receipt,
  type ImageExecutionReceipt,
} from "~/server/domains/image-processing/repo/execution-receipts";
const data = imageProcessingEvent.details;
/** Append a complete receipt snapshot; callers hold the job lock for ordering. */
export async function appendExecutionReceipt(
  db: Database | DrizzleTransaction,
  input: {
    id: string;
    jobId: string;
    patch: Partial<Omit<ImageExecutionReceipt, "id" | "jobId">>;
  },
): Promise<ImageExecutionReceipt> {
  const q = unwrapDb(db);
  const jobs = await q
    .select({ id: imageProcessingJob.id })
    .from(imageProcessingJob)
    .where(
      sql`(${imageProcessingJob.id}=${input.jobId}::uuid OR ${imageProcessingJob.askId}=${input.jobId}::uuid)`,
    );
  const jobId = jobs[0]?.id;
  if (!jobId) throw new Error("Missing image request receipt");
  const [previous] = await q
    .select({ details: imageProcessingEvent.details })
    .from(imageProcessingEvent)
    .where(
      and(
        eq(imageProcessingEvent.event, "execution.receipt"),
        sql`${data}->>'id'=${input.id}`,
      ),
    )
    .orderBy(
      desc(imageProcessingEvent.occurredAt),
      desc(imageProcessingEvent.id),
    )
    .limit(1);
  const base = previous
    ? receipt.parse(previous.details)
    : {
        id: input.id,
        jobId,
        number: 1,
        submissionId: null,
        inputKey: null,
        state: "running",
        executor: null,
        assignedUserId: null,
        assignedConnectionId: null,
        diagnostics: null,
        result: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
  const previousDiagnostics = z
    .record(z.string(), z.unknown())
    .safeParse(base.diagnostics);
  const patchDiagnostics = z
    .record(z.string(), z.unknown())
    .safeParse(input.patch.diagnostics);
  const next = receipt.parse({
    ...base,
    ...input.patch,
    ...(previousDiagnostics.success && patchDiagnostics.success
      ? {
          diagnostics: {
            ...previousDiagnostics.data,
            ...patchDiagnostics.data,
          },
        }
      : {}),
  });
  await q.insert(imageProcessingEvent).values({
    jobId,
    eventKey: `${input.id}:receipt:${crypto.randomUUID()}`,
    event: "execution.receipt",
    details: next,
    occurredAt: sql`clock_timestamp()`,
  });
  return next;
}
