import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  imageProcessingAttempt,
  imageProcessingJob,
  imageProcessingOrphan,
} from "~/server/db/image-processing-schema";
import { image } from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";

export async function recordImageDescriptionInput(
  db: Database,
  input: {
    attemptId: string;
    sourceHash: string;
    sourceKey: string;
    fingerprint: string;
    provider: string;
    model: string;
    promptRevision: number;
    schemaRevision: number;
    normalizationRevision: number;
    request: { systemPrompts: string[] };
    cached: boolean;
    renditionKey?: string;
    renditionHash?: string;
  },
) {
  const { attemptId, request, ...metadata } = input;
  await getDb(db)
    .update(imageProcessingAttempt)
    .set({
      diagnostics: sql`coalesce(${imageProcessingAttempt.diagnostics}, '{}'::jsonb) || ${JSON.stringify({ ...metadata, systemPrompts: request.systemPrompts, userPrompt: "Analyze the original image. Do not describe a generated cutout.", inputAvailability: input.renditionKey ? "recorded" : input.cached ? "historical input unavailable" : "input not yet recorded" })}::jsonb`,
    })
    .where(eq(imageProcessingAttempt.id, attemptId));
}

/** Register the output before PUT; image deletion retains the key for late cleanup. */
export async function reserveImageAnalysisInput(
  db: Database,
  attemptId: string,
  key: string,
) {
  return withTransaction(db, async (tx) => {
    const [attempt] = await tx
      .select({ id: imageProcessingAttempt.id })
      .from(imageProcessingAttempt)
      .innerJoin(
        imageProcessingJob,
        eq(imageProcessingJob.id, imageProcessingAttempt.jobId),
      )
      .innerJoin(image, eq(image.id, imageProcessingJob.imageId))
      .where(
        and(
          eq(imageProcessingAttempt.id, attemptId),
          eq(imageProcessingJob.attemptId, attemptId),
          eq(imageProcessingJob.state, "leased"),
        ),
      )
      .for("update");
    if (!attempt) return false;
    await tx
      .insert(imageProcessingOrphan)
      .values({ key, attemptId, reason: "analysis_input_upload" })
      .onConflictDoNothing();
    await tx
      .update(imageProcessingAttempt)
      .set({ inputKey: key })
      .where(eq(imageProcessingAttempt.id, attemptId));
    return true;
  });
}

export async function retainImageAnalysisInput(
  db: Database,
  attemptId: string,
  key: string,
) {
  return withTransaction(db, async (tx) => {
    const [attempt] = await tx
      .select({ id: imageProcessingAttempt.id })
      .from(imageProcessingAttempt)
      .where(
        and(
          eq(imageProcessingAttempt.id, attemptId),
          eq(imageProcessingAttempt.inputKey, key),
        ),
      )
      .for("update");
    if (!attempt) return false;
    await tx
      .delete(imageProcessingOrphan)
      .where(eq(imageProcessingOrphan.key, key));
    return true;
  });
}
