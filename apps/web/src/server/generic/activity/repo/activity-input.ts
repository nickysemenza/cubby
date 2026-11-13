import { and, eq, isNotNull } from "drizzle-orm";

import type { AiChatRequest } from "~/server/ai/policy/feature-identity";
import type { Database } from "~/server/db";
import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import {
  imageProcessingJob,
  imageProcessingOrphan,
} from "~/server/db/image-processing-schema";
import { image } from "~/server/db/schema";
import { appendExecutionReceipt } from "~/server/domains/image-processing/repo/execution-receipt-write";
import { imageExecutionReceipts } from "~/server/domains/image-processing/repo/execution-receipts";

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
    request: Pick<AiChatRequest, "systemPrompts" | "messages">;
    cached: boolean;
    renditionKey?: string;
    renditionHash?: string;
  },
) {
  const { attemptId, request, ...metadata } = input;
  const userPrompt = request.messages
    .flatMap(({ content }) =>
      typeof content === "string"
        ? [content]
        : content.flatMap((part) =>
            part.type === "text" ? [part.content] : [],
          ),
    )
    .join("\n");
  const [current] = await getDb(db)
    .select()
    .from(imageExecutionReceipts)
    .where(eq(imageExecutionReceipts.id, attemptId));
  if (current)
    await appendExecutionReceipt(db, {
      id: attemptId,
      jobId: current.jobId,
      patch: {
        diagnostics: {
          ...metadata,
          systemPrompts: request.systemPrompts,
          userPrompt,
          inputAvailability: input.renditionKey
            ? "recorded"
            : input.cached
              ? "historical input unavailable"
              : "input not yet recorded",
        },
      },
    });
}

/** Register the output before PUT; image deletion retains the key for late cleanup. */
export async function reserveImageAnalysisInput(
  db: Database,
  attemptId: string,
  key: string,
  expectedInputKey?: string,
) {
  return withTransaction(db, async (tx) => {
    const [attempt] = await tx
      .select({ id: imageExecutionReceipts.id })
      .from(imageExecutionReceipts)
      .innerJoin(
        imageProcessingJob,
        eq(imageProcessingJob.id, imageExecutionReceipts.jobId),
      )
      .innerJoin(image, eq(image.id, imageProcessingJob.imageId))
      .where(
        and(
          eq(imageExecutionReceipts.id, attemptId),
          expectedInputKey === undefined
            ? undefined
            : eq(imageExecutionReceipts.inputKey, expectedInputKey),
          eq(imageProcessingJob.attemptId, attemptId),
          eq(imageProcessingJob.state, "pending"),
          // The unchanged attempt is the authority: an expired lease no newer
          // claim replaced still belongs to it (late adoption).
          isNotNull(imageProcessingJob.leaseUntil),
          eq(image.status, "UPLOADED"),
          eq(image.sha256, imageProcessingJob.sourceContentHash),
          notDeleted(image),
        ),
      )
      .for("update", { of: [imageProcessingJob, image] });
    if (!attempt) return false;
    await tx
      .insert(imageProcessingOrphan)
      .values({ key, attemptId, reason: "analysis_input_upload" })
      .onConflictDoNothing();
    const [current] = await tx
      .select()
      .from(imageExecutionReceipts)
      .where(eq(imageExecutionReceipts.id, attemptId));
    if (current)
      await appendExecutionReceipt(tx, {
        id: attemptId,
        jobId: current.jobId,
        patch: { inputKey: key },
      });
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
      .select({ id: imageExecutionReceipts.id })
      .from(imageExecutionReceipts)
      .innerJoin(
        imageProcessingJob,
        eq(imageProcessingJob.id, imageExecutionReceipts.jobId),
      )
      .innerJoin(image, eq(image.id, imageProcessingJob.imageId))
      .where(
        and(
          eq(imageExecutionReceipts.id, attemptId),
          eq(imageExecutionReceipts.inputKey, key),
          eq(imageProcessingJob.attemptId, attemptId),
          eq(imageProcessingJob.state, "pending"),
          // The unchanged attempt is the authority: an expired lease no newer
          // claim replaced still belongs to it (late adoption).
          isNotNull(imageProcessingJob.leaseUntil),
          eq(image.status, "UPLOADED"),
          eq(image.sha256, imageProcessingJob.sourceContentHash),
          notDeleted(image),
        ),
      )
      .for("update", { of: [imageProcessingJob, image] });
    if (!attempt) return false;
    await tx
      .delete(imageProcessingOrphan)
      .where(eq(imageProcessingOrphan.key, key));
    return true;
  });
}
