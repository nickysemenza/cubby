import type { AiAnalysisRuntime } from "@cubby/schemas/ai";
import {
  parseEntityId,
  type ImageId,
  type RunId,
} from "@cubby/schemas/identifiers";
import { ImageStatus } from "@cubby/schemas/image";
import {
  IMAGE_IDENTIFICATION_MODEL,
  IMAGE_IDENTIFICATION_PROMPT_REVISION,
  IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
  type ImageIdentificationResult,
} from "@cubby/schemas/image-identification";
import {
  imageProcessingJobKind,
  imageDescriptionResult,
  imageDescriptionAnalysis,
  selectImageDescription,
  type ImageDescriptionResult,
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import type {
  ImageProcessingJobKind,
  ImageProcessingJobState,
  ImageProcessingTerminalResult as ImageProcessingResult,
} from "@cubby/schemas/image-processing";
import type { ImageRepresentations } from "@cubby/schemas/image-summary";
import { jobState } from "@cubby/schemas/job";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import {
  generateImageKey,
  PRESIGNED_URL_DEFAULT_EXPIRY_SECONDS,
} from "~/server/clients/s3";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  getDb,
  unwrapDb,
  notDeleted,
  withTransaction,
  withTransactionOn,
  databaseForTransaction,
} from "~/server/db/helpers";
import {
  imageDerivative,
  imageProcessingOrphan,
  imageProcessingJob,
  imageProcessingAttempt,
  imageProcessingSubmissionJob,
} from "~/server/db/image-processing-schema";
import { repositoryBeforeCommit } from "~/server/db/repository-access.boundary";
import { job as durableJob } from "~/server/db/retained-tables";
import { aiAnalysis, image } from "~/server/db/schema";
import {
  isCurrentPreferredImageDescription,
  parseImageDescriptionInputFingerprint,
  preferredImageDescriptionPolicy,
} from "~/server/domains/image-processing/repo/description-policy";
import { MAIL_ATTACHMENT_UPLOAD_REASON } from "~/server/domains/mail/repo/mail-attachment-uploads";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { readConfirmedDescription } from "~/server/generic/assessment/repo/assessment-image";
import { recordChange } from "~/server/generic/changes/repo/change";
import { currentJobExecution } from "~/server/generic/jobs/context";
import {
  enqueueJob,
  claimJob,
  externalJobClaim,
  publishJobPage,
  failJob,
  retryJob,
  assertJobClaim,
  JobSupersededError,
} from "~/server/generic/jobs/repo/jobs";
import { findOrCreateWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  insertImageProcessingAttempt,
  recordImageProcessingEvent,
} from "./image-processing-history";

/** Failures since the last operator retry that end a job as `failed`. */
export const IMAGE_PROCESSING_MAX_ATTEMPTS = 3;

/** A server-side failure stays retryable; the failure budget decides when it ends. */
export const SERVER_FAILURE_RETRYABLE = true;

// Cloud eligibility no longer gates Apple subject lifting; prior skipped work can be rescheduled.
export const IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION = 2;
// This policy revision changes eligibility, not the cutout format or algorithm.
const compatibleSubjectLiftOutputs = [1, IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION];

/**
 * Jobs are unique by an integer revision. Derive that revision from every
 * cloud-analysis input that changes the result so a model, provider, prompt,
 * schema, or rendition revision creates fresh work without touching cutouts.
 */
function stableProcessorRevision(identity: string): number {
  let hash = 0x811c9dc5;
  for (const character of identity) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2_000_000_000 || 1;
}

export const IMAGE_DESCRIPTION_PROCESSOR_REVISION = stableProcessorRevision(
  [
    "cloud",
    preferredImageDescriptionPolicy.provider,
    preferredImageDescriptionPolicy.model,
    preferredImageDescriptionPolicy.promptRevision,
    preferredImageDescriptionPolicy.resultSchemaRevision,
    `orientation-rendition-v${preferredImageDescriptionPolicy.normalizationRevision}`,
  ].join("/"),
);
/** Separate identity keeps opt-in Apple evaluations from replacing cloud work. */
export const IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION =
  stableProcessorRevision(
    [
      "apple",
      IMAGE_DESCRIPTION_PROMPT_REVISION,
      IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
      "actual-image-description-v1",
    ].join("/"),
  );

export const IMAGE_IDENTIFICATION_PROCESSOR_REVISION = stableProcessorRevision(
  [
    "cloud",
    IMAGE_IDENTIFICATION_MODEL,
    IMAGE_IDENTIFICATION_PROMPT_REVISION,
    IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
  ].join("/"),
);

const currentImageProcessingProcessor = () => sql<boolean>`(
  (${imageProcessingJob.kind} = ${imageProcessingJobKind.enum.subject_lift}
    AND ${imageProcessingJob.processorRevision} = ${IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION})
  OR (${imageProcessingJob.kind} = ${imageProcessingJobKind.enum.identify_image}
    AND ${imageProcessingJob.processorRevision} = ${IMAGE_IDENTIFICATION_PROCESSOR_REVISION})
  OR (${imageProcessingJob.kind} = ${imageProcessingJobKind.enum.describe_image}
    AND ${imageProcessingJob.processorRevision} IN (${IMAGE_DESCRIPTION_PROCESSOR_REVISION}, ${IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION}))
)`;

const obsoleteImageProcessingSource = () => sql<boolean>`(
  ${image.deletedAt} IS NOT NULL OR ${image.status} <> ${ImageStatus.enum.UPLOADED}
  OR ${image.sha256} IS NULL OR ${image.sha256} <> ${imageProcessingJob.sourceContentHash}
)`;

type JobIdentity = {
  imageId: ImageId;
  kind: ImageProcessingJobKind;
  sourceContentHash: string;
  processorRevision: number;
  /** The Run that requested this job, when the caller has one. */
  runId?: RunId | null;
};

export type ClaimedImageProcessingJob = {
  id: string;
  imageId: ImageId;
  kind: ImageProcessingJobKind;
  sourceContentHash: string;
  processorRevision: number;
  attemptId: string;
  derivativeId: string | null;
  originalKey: string;
  originalContentType: string;
  derivativeKey: string | null;
  /** The Run that requested this job, when one was recorded at scheduling. */
  runId: RunId | null;
  /** Database-authoritative end of this attempt's presigned capabilities. */
  leaseExpiresAt: Date;
};

/** Read-only source boundary shared by scheduling and the AI Gateway service. */
export async function getUploadedImageProcessingSource(
  db: Database,
  imageId: ImageId,
): Promise<{
  id: ImageId;
  shortcode: string;
  key: string;
  sha256: string;
  contentType: string;
} | null> {
  const [source] = await getDb(db)
    .select({
      id: image.id,
      shortcode: image.shortcode,
      key: image.key,
      sha256: image.sha256,
      contentType: image.contentType,
      status: image.status,
    })
    .from(image)
    .where(and(eq(image.id, imageId), notDeleted(image)))
    .limit(1);
  if (!source || source.status !== "UPLOADED" || !source.sha256) return null;
  return {
    id: parseEntityId("image", source.id),
    shortcode: source.shortcode,
    key: source.key,
    sha256: source.sha256,
    contentType: source.contentType,
  };
}

export async function findCachedImageDescriptionAnalysis(
  db: Database,
  input: {
    imageId: ImageId;
    provider: string;
    model: string;
    promptVersion: string;
    resultSchemaRevision: number;
    inputFingerprint: string;
  },
): Promise<ImageDescriptionResult | null> {
  const cached = await getDb(db).query.aiAnalysis.findFirst({
    where: and(
      eq(aiAnalysis.entityKind, "image"),
      eq(aiAnalysis.entityId, input.imageId),
      eq(aiAnalysis.feature, "image-description"),
      eq(aiAnalysis.provider, input.provider),
      eq(aiAnalysis.model, input.model),
      eq(aiAnalysis.promptVersion, input.promptVersion),
      eq(aiAnalysis.resultSchemaRevision, input.resultSchemaRevision),
      eq(aiAnalysis.inputFingerprint, input.inputFingerprint),
      notDeleted(aiAnalysis),
    ),
    columns: { result: true },
  });
  const parsed = imageDescriptionResult.safeParse(cached?.result);
  return parsed.success ? parsed.data : null;
}

/**
 * Create a unique durable job. The worker queue only wakes this row; retries
 * and completion are guarded by its attempt, not by message delivery count.
 */
export async function createImageProcessingJob(
  db: Database,
  input: JobIdentity & { derivativeId?: string | null },
): Promise<string | null> {
  const [liveImage] = await getDb(db)
    .select({
      id: image.id,
      status: image.status,
      sha256: image.sha256,
    })
    .from(image)
    .where(and(eq(image.id, input.imageId), notDeleted(image)))
    .limit(1);
  if (
    !liveImage ||
    liveImage.status !== "UPLOADED" ||
    liveImage.sha256 !== input.sourceContentHash
  )
    return null;

  const job = await ensureImageProcessingJob(db, {
    ...input,
    derivativeId: input.derivativeId ?? null,
    runId: input.runId ?? null,
  });
  return job.id;
}

/**
 * The one job per (Image, kind, source, revision). A concurrent scheduler
 * finds the winner's row; a shortcode collision retries with a new code
 * instead of being mistaken for that duplicate.
 */
async function ensureImageProcessingJob(
  db: Database | DrizzleTransaction,
  values: JobIdentity & {
    derivativeId: string | null;
    runId: RunId | null;
  },
) {
  return withTransactionOn(db, async (tx) => {
    const { row } = await findOrCreateWithShortcode(tx, "imageJob", {
      where: and(
        eq(imageProcessingJob.imageId, values.imageId),
        eq(imageProcessingJob.kind, values.kind),
        eq(imageProcessingJob.sourceContentHash, values.sourceContentHash),
        eq(imageProcessingJob.processorRevision, values.processorRevision),
      ),
      values: () => ({ ...values, state: "pending" as const }),
    });
    if (["pending", "leased", "waiting_for_device"].includes(row.state))
      await enqueueJob(tx, {
        key: `image-processing:${row.id}`,
        kind: "image.processing",
        subjectKind: "image",
        subjectId: row.imageId,
        input: { processingId: row.id },
        runId: row.runId,
      });
    return row;
  });
}

export async function createTransparentDerivativeAndJob(
  db: Database,
  input: {
    imageId: ImageId;
    sourceContentHash: string;
    key: string;
    /** The Run that requested this job, when the caller has one. */
    runId?: RunId | null;
  },
): Promise<{ derivativeId: string; jobId: string } | null> {
  return await withTransaction(db, async (tx) => {
    const [liveImage] = await tx
      .select({ id: image.id, status: image.status, sha256: image.sha256 })
      .from(image)
      .where(and(eq(image.id, input.imageId), notDeleted(image)))
      .for("update");
    if (
      !liveImage ||
      liveImage.status !== "UPLOADED" ||
      liveImage.sha256 !== input.sourceContentHash
    )
      return null;

    await tx
      .insert(imageDerivative)
      .values({
        imageId: input.imageId,
        purpose: "transparent",
        status: "pending",
        key: input.key,
        sourceContentHash: input.sourceContentHash,
        processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
      })
      .onConflictDoNothing();
    const derivative = await tx.query.imageDerivative.findFirst({
      where: and(
        eq(imageDerivative.imageId, input.imageId),
        eq(imageDerivative.purpose, "transparent"),
        eq(imageDerivative.sourceContentHash, input.sourceContentHash),
        eq(
          imageDerivative.processorRevision,
          IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
        ),
        notDeleted(imageDerivative),
      ),
      columns: { id: true, status: true, failureReason: true },
    });
    if (!derivative) throw new Error("Image derivative was not persisted");

    const job = await ensureImageProcessingJob(tx, {
      imageId: input.imageId,
      derivativeId: derivative.id,
      kind: "subject_lift",
      sourceContentHash: input.sourceContentHash,
      processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
      runId: input.runId ?? null,
    });
    return { derivativeId: derivative.id, jobId: job.id };
  });
}

/**
 * Expired leases are safe to retry because every completion must echo
 * attemptId. An expired executor attempt spends the retry budget, so an
 * executor that always dies mid-job cannot loop forever.
 */
/** Claim one job with a bounded lease. No HTTP path waits for device work. */
export async function claimImageProcessingJob(
  db: Database,
  input: {
    kinds: readonly ImageProcessingJobKind[];
    leaseMs: number;
    /** A queue wakeup must never lease an unrelated row. */
    jobId?: string;
    /** Device pulls can execute only declared processor revisions, never cloud jobs. */
    processorRevisions?: readonly number[];
    /** A normalization-capable device may prepare cloud AVIF input, never other cloud jobs. */
    allowAvifNormalization?: boolean;
  },
): Promise<ClaimedImageProcessingJob | null> {
  // Candidate selection uses the same due-time clock as the shared Job claim.
  const now = new Date();
  const currentExecution = currentJobExecution();
  return await withTransaction(db, async (tx) => {
    if (currentExecution) {
      if (
        !input.jobId ||
        currentExecution.claim.kind !== "image.processing" ||
        currentExecution.claim.key !== `image-processing:${input.jobId}`
      )
        throw new Error(
          "Image processing requires its own universal Job claim",
        );
      await assertJobClaim(
        databaseForTransaction(tx),
        currentExecution.claim,
        "update",
      );
      await tx
        .update(imageProcessingJob)
        .set({
          state: "skipped",
          completedAt: new Date(),
          lastError: "Image source or processor is obsolete",
        })
        .where(
          and(
            eq(imageProcessingJob.id, input.jobId),
            inArray(imageProcessingJob.state, [
              "pending",
              "waiting_for_device",
              "leased",
            ]),
            // includes-deleted: retire work whose source image was removed.
            sql`EXISTS (SELECT 1 FROM ${image} WHERE ${image.id}=${imageProcessingJob.imageId} AND (${obsoleteImageProcessingSource()} OR NOT ${currentImageProcessingProcessor()}))`,
          ),
        );
    }
    // The internal policy keeps claims within the device’s supported job kinds.
    const candidates = tx
      .select({
        id: imageProcessingJob.id,
        executionId: durableJob.id,
        imageId: imageProcessingJob.imageId,
        kind: imageProcessingJob.kind,
        sourceContentHash: imageProcessingJob.sourceContentHash,
        processorRevision: imageProcessingJob.processorRevision,
        previousAttemptId: imageProcessingJob.attemptId,
        submissionId: imageProcessingJob.submissionId,
        derivativeId: imageProcessingJob.derivativeId,
        runId: imageProcessingJob.runId,
        originalKey: image.key,
        originalContentType: image.contentType,
        derivativeKey: imageDerivative.key,
      })
      .from(imageProcessingJob)
      .innerJoin(
        durableJob,
        eq(
          durableJob.key,
          sql`'image-processing:' || ${imageProcessingJob.id}::text`,
        ),
      )
      .innerJoin(
        image,
        and(
          eq(image.id, imageProcessingJob.imageId),
          notDeleted(image),
          eq(image.status, "UPLOADED"),
          eq(image.sha256, imageProcessingJob.sourceContentHash),
        ),
      )
      .leftJoin(
        imageDerivative,
        and(
          eq(imageDerivative.id, imageProcessingJob.derivativeId),
          notDeleted(imageDerivative),
        ),
      )
      .where(
        and(
          input.jobId ? eq(imageProcessingJob.id, input.jobId) : undefined,
          inArray(imageProcessingJob.kind, [...input.kinds]),
          inArray(imageProcessingJob.state, [
            "pending",
            "waiting_for_device",
            "leased",
          ]),
          currentImageProcessingProcessor(),
          input.processorRevisions
            ? or(
                inArray(imageProcessingJob.processorRevision, [
                  ...input.processorRevisions,
                ]),
                input.allowAvifNormalization
                  ? and(
                      eq(imageProcessingJob.kind, "describe_image"),
                      eq(
                        imageProcessingJob.processorRevision,
                        IMAGE_DESCRIPTION_PROCESSOR_REVISION,
                      ),
                      eq(image.contentType, "image/avif"),
                    )
                  : undefined,
              )
            : undefined,
          currentExecution
            ? and(
                eq(durableJob.id, currentExecution.claim.id),
                eq(durableJob.state, "running"),
                eq(durableJob.generation, currentExecution.claim.generation),
                eq(durableJob.leaseToken, currentExecution.claim.leaseToken),
                gt(durableJob.leaseExpiresAt, now),
              )
            : or(
                and(
                  inArray(durableJob.state, ["queued", "retry_wait"]),
                  input.processorRevisions
                    ? or(
                        lte(durableJob.availableAt, now),
                        eq(imageProcessingJob.state, "waiting_for_device"),
                      )
                    : lte(durableJob.availableAt, now),
                ),
                and(
                  eq(durableJob.state, "running"),
                  lte(durableJob.leaseExpiresAt, now),
                ),
              ),
        ),
      )
      .orderBy(asc(durableJob.availableAt), asc(imageProcessingJob.id))
      .limit(1);
    const [candidate] = await (currentExecution
      ? candidates.for("update", { of: [imageProcessingJob, image] })
      : candidates.for("update", {
          of: [imageProcessingJob, image],
          skipLocked: true,
        }));
    if (!candidate) return null;

    if (!currentExecution && input.processorRevisions)
      await tx
        .update(durableJob)
        .set({ availableAt: new Date() })
        .where(
          and(
            eq(durableJob.id, candidate.executionId),
            eq(durableJob.state, "queued"),
          ),
        );
    const execution =
      currentExecution?.claim ??
      (await claimJob(
        databaseForTransaction(tx),
        candidate.executionId,
        input.leaseMs,
      ));
    if (!execution) return null;
    // A missing output record is a permanent domain failure, retained on Job.
    if (candidate.kind === "subject_lift" && !candidate.derivativeKey) {
      execution.attempts = execution.maxAttempts;
      await failJob(
        databaseForTransaction(tx),
        execution,
        new Error("Transparent derivative is unavailable"),
      );
      await tx
        .update(imageProcessingJob)
        .set({
          state: "failed",
          completedAt: new Date(),
          lastError: "Transparent derivative is unavailable",
        })
        .where(eq(imageProcessingJob.id, candidate.id));
      return null;
    }

    const attemptId = execution.leaseToken;
    if (
      candidate.previousAttemptId &&
      candidate.previousAttemptId !== attemptId
    )
      await tx
        .update(imageProcessingAttempt)
        .set({
          state: "expired",
          completedAt: new Date(),
          error: "Universal Job lease expired",
        })
        .where(
          and(
            eq(imageProcessingAttempt.id, candidate.previousAttemptId),
            eq(imageProcessingAttempt.state, "running"),
          ),
        );
    // Every lease gets a new server-chosen key. A late PUT authorized by an
    // earlier presigned URL can therefore never overwrite the next attempt.
    const derivativeKey =
      candidate.kind === "subject_lift"
        ? generateImageKey(`image-${candidate.imageId}-transparent.png`)
        : candidate.derivativeKey;
    if (candidate.kind === "subject_lift" && candidate.derivativeId) {
      await tx
        .insert(imageProcessingOrphan)
        .values({
          key: candidate.derivativeKey!,
          attemptId: candidate.previousAttemptId,
          reason: "Superseded image-processing output key",
        })
        .onConflictDoNothing();
      await tx
        .update(imageDerivative)
        .set({ key: derivativeKey!, status: "pending", failureReason: null })
        .where(eq(imageDerivative.id, candidate.derivativeId));
    }
    await tx
      .update(imageProcessingJob)
      .set({
        state: "leased",
        attemptId,
        dispatchedAt: new Date(),
      })
      .where(eq(imageProcessingJob.id, candidate.id));
    const {
      previousAttemptId: _previousAttemptId,
      executionId: _executionId,
      ...claimed
    } = candidate;
    return {
      ...claimed,
      imageId: parseEntityId("image", claimed.imageId),
      derivativeKey,
      attemptId,
      leaseExpiresAt: execution.leaseExpiresAt,
    };
  });
}

/** Read the one output key bound to a live attempt before validating its bytes. */
export async function getLeasedImageProcessingOutputKey(
  db: Database,
  input: { jobId: string; attemptId: string },
): Promise<string | null> {
  const row = await getDb(db)
    .select({ key: imageDerivative.key })
    .from(imageProcessingJob)
    .innerJoin(
      imageDerivative,
      and(
        eq(imageDerivative.id, imageProcessingJob.derivativeId),
        notDeleted(imageDerivative),
      ),
    )
    .where(
      and(
        eq(imageProcessingJob.id, input.jobId),
        eq(imageProcessingJob.attemptId, input.attemptId),
        eq(imageProcessingJob.state, "leased"),
        sql`EXISTS (SELECT 1 FROM "Job" j WHERE j.key='image-processing:' || ${imageProcessingJob.id}::text AND j.state=${jobState.enum.running} AND j."leaseToken"=${input.attemptId}::uuid AND j."leaseExpiresAt">now())`,
      ),
    )
    .limit(1);
  return row[0]?.key ?? null;
}

export async function getLeasedImageProcessingJobContext(
  db: Database,
  input: { jobId: string; attemptId: string },
) {
  const rows = await getDb(db)
    .select({
      imageId: imageProcessingJob.imageId,
      sourceShortcode: image.shortcode,
      sourceContentHash: imageProcessingJob.sourceContentHash,
      contentType: image.contentType,
      kind: imageProcessingJob.kind,
      processorRevision: imageProcessingJob.processorRevision,
      runId: imageProcessingJob.runId,
      inputKey: imageProcessingAttempt.inputKey,
    })
    .from(imageProcessingJob)
    .innerJoin(
      imageProcessingAttempt,
      and(
        eq(imageProcessingAttempt.jobId, imageProcessingJob.id),
        eq(imageProcessingAttempt.id, imageProcessingJob.attemptId),
      ),
    )
    .innerJoin(
      image,
      and(
        eq(image.id, imageProcessingJob.imageId),
        notDeleted(image),
        eq(image.status, "UPLOADED"),
        eq(image.sha256, imageProcessingJob.sourceContentHash),
      ),
    )
    .where(
      and(
        eq(imageProcessingJob.id, input.jobId),
        eq(imageProcessingJob.attemptId, input.attemptId),
        eq(imageProcessingJob.state, "leased"),
        sql`EXISTS (SELECT 1 FROM "Job" j WHERE j.key='image-processing:' || ${imageProcessingJob.id}::text AND j.state=${jobState.enum.running} AND j."leaseToken"=${input.attemptId}::uuid AND j."leaseExpiresAt">now())`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * No capable device was reachable. A lease with no executor is not an
 * attempt, and a capable device's pull claims this row before the cooldown;
 * the per-job event key keeps idle cycles out of history.
 */
export async function markImageProcessingWaitingForDevice(
  db: Database,
  input: { jobId: string; attemptId: string },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const execution = await externalJobClaim(
      tx,
      `image-processing:${input.jobId}`,
      input.attemptId,
      true,
    );
    if (!execution) return;
    await publishJobPage(databaseForTransaction(tx), execution, {
      done: false,
      waitUntil: new Date(Date.now() + 60_000),
      waitReason: "device",
    });
    const rows = await tx
      .update(imageProcessingJob)
      .set({
        state: "waiting_for_device",
        attemptId: null,
      })
      .where(
        and(
          eq(imageProcessingJob.id, input.jobId),
          eq(imageProcessingJob.attemptId, input.attemptId),
          eq(imageProcessingJob.state, "leased"),
        ),
      )
      .returning({ id: imageProcessingJob.id });
    if (rows.length)
      await recordImageProcessingEvent(tx, {
        jobId: input.jobId,
        eventKey: "dispatch:waiting",
        event: "dispatch.waiting",
      });
  });
}

/**
 * A capable device claimed the row but it could not be handed over. The row
 * returns to `pending` so the cooldown holds: a waiting row would be reclaimed
 * by the same device's next pull, rotating subject-lift output keys each time.
 * Each backoff spends the retry budget, so a hand-off that always fails ends.
 */
export async function backOffImageProcessingLease(
  db: Database,
  input: { jobId: string; attemptId: string; reason: string },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const [job] = await tx
      .select({
        id: imageProcessingJob.id,
        derivativeId: imageProcessingJob.derivativeId,
      })
      .from(imageProcessingJob)
      .where(
        and(
          eq(imageProcessingJob.id, input.jobId),
          eq(imageProcessingJob.attemptId, input.attemptId),
          eq(imageProcessingJob.state, "leased"),
        ),
      )
      .for("update");
    if (!job) return;
    await settleImageProcessingFailure(tx, job, {
      reason: input.reason,
      retryable: true,
      set: { attemptId: null },
    });
    await recordImageProcessingEvent(tx, {
      jobId: input.jobId,
      eventKey: "dispatch:backoff",
      event: "dispatch.backoff",
      level: "error",
      details: { reason: input.reason },
    });
  });
}

/** Bounded maintenance retry; old result/runtime remains immutable history. */
export async function retryFailedImageProcessingJobs(
  db: Database,
  limit: number,
  options?: {
    imageId?: ImageId;
    submissionId?: string;
    kinds?: readonly ImageProcessingJobKind[];
  },
): Promise<string[]> {
  return await withTransaction(db, async (tx) => {
    const rows = await tx
      .select({
        id: imageProcessingJob.id,
        attempts: imageProcessingJob.attempts,
      })
      .from(imageProcessingJob)
      .innerJoin(
        image,
        and(
          eq(image.id, imageProcessingJob.imageId),
          notDeleted(image),
          eq(image.sha256, imageProcessingJob.sourceContentHash),
        ),
      )
      .where(
        and(
          eq(imageProcessingJob.state, "failed"),
          options?.imageId
            ? eq(imageProcessingJob.imageId, options.imageId)
            : undefined,
          options?.kinds
            ? inArray(imageProcessingJob.kind, [...options.kinds])
            : undefined,
          currentImageProcessingProcessor(),
        ),
      )
      .orderBy(asc(imageProcessingJob.completedAt), asc(imageProcessingJob.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    for (const id of ids) {
      const [execution] = await tx
        .select({ id: durableJob.id })
        .from(durableJob)
        .where(eq(durableJob.key, `image-processing:${id}`));
      if (execution) await retryJob(databaseForTransaction(tx), execution.id);
    }
    if (options?.submissionId)
      await tx
        .insert(imageProcessingSubmissionJob)
        .values(
          rows.map((row) => ({
            submissionId: options.submissionId!,
            jobId: row.id,
            disposition: "retry",
            baselineAttempts: row.attempts,
          })),
        )
        .onConflictDoNothing();
    await tx
      .update(imageProcessingJob)
      .set({
        state: "pending",
        attemptId: null,
        lastError: null,
        completedAt: null,
        submissionId: options?.submissionId ?? null,
      })
      .where(inArray(imageProcessingJob.id, ids));
    return ids;
  });
}

export async function findImageProcessingWakeupsForImage(
  db: Database,
  imageId: ImageId,
): Promise<string[]> {
  const rows = await getDb(db)
    .select({ id: imageProcessingJob.id })
    .from(imageProcessingJob)
    .where(
      and(
        eq(imageProcessingJob.imageId, imageId),
        or(
          eq(imageProcessingJob.state, "pending"),
          eq(imageProcessingJob.state, "waiting_for_device"),
        ),
      ),
    );
  return rows.map((row) => row.id);
}

type DescriptionAnalysisIdentity = {
  provider: string;
  model: string;
  promptRevision: number;
  resultSchemaRevision: number;
  inputFingerprint: string;
};

/** Cloud decisions never enter the companion command/result protocol. */
type IdentificationCompletion = Omit<ImageProcessingResult, "outcome"> & {
  outcome:
    | {
        kind: "identify_image";
        status: "completed";
        identification: ImageIdentificationResult;
      }
    | {
        kind: "identify_image";
        status: "failed";
        retryable: boolean;
        reason: string;
      }
    | {
        kind: "identify_image";
        status: "skipped";
        reason: "unsupported_format" | "not_suitable" | "no_subject";
      };
};

type CompletionInput = {
  result: ImageProcessingResult | IdentificationCompletion;
  runtime?: AiAnalysisRuntime;
  verifiedDerivative?: {
    sha256: string;
    contentType: "image/png";
    width: number;
    height: number;
  };
  /** Analysis insertion and artifact adoption share the current-attempt fence. */
  appleAnalysis?: DescriptionAnalysisIdentity;
  cloudAnalysis?: DescriptionAnalysisIdentity;
  identificationAnalysis?: DescriptionAnalysisIdentity;
  /** A rejected output belongs to this verified attempt and is retired atomically. */
  orphanOutputKey?: string;
};

type CompletionJob = {
  id: string;
  imageId: ImageId;
  derivativeId: string | null;
  kind: ImageProcessingJobKind;
  state: ImageProcessingJobState;
  attemptId: string | null;
  leaseValid: boolean;
  sourceContentHash: string;
  processorRevision: number;
  imageHash: string | null;
  imageStatus: string;
};

function canAdoptCompletion(
  job: CompletionJob | undefined,
  input: CompletionInput,
): job is CompletionJob {
  if (!job) return false;
  const outcome = input.result.outcome;
  const revisionMatches =
    (job.kind === "subject_lift" &&
      job.processorRevision === IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION) ||
    (job.kind === "identify_image" &&
      job.processorRevision === IMAGE_IDENTIFICATION_PROCESSOR_REVISION) ||
    (job.kind === "describe_image" &&
      (job.processorRevision === IMAGE_DESCRIPTION_PROCESSOR_REVISION ||
        job.processorRevision === IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION));
  const appleAnalysisMatches = input.appleAnalysis
    ? job.processorRevision === IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION &&
      outcome.status === "completed" &&
      outcome.kind === "describe_image"
    : !(
        job.processorRevision === IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION &&
        outcome.status === "completed"
      );
  return (
    job.kind === outcome.kind &&
    job.state === "leased" &&
    job.attemptId === input.result.attemptId &&
    job.leaseValid &&
    job.imageHash === job.sourceContentHash &&
    job.imageStatus === ImageStatus.enum.UPLOADED &&
    revisionMatches &&
    appleAnalysisMatches &&
    (outcome.kind !== "identify_image" ||
      outcome.status !== "completed" ||
      (input.identificationAnalysis?.model === IMAGE_IDENTIFICATION_MODEL &&
        input.identificationAnalysis.provider === "cloudflare" &&
        input.identificationAnalysis.promptRevision ===
          IMAGE_IDENTIFICATION_PROMPT_REVISION &&
        input.identificationAnalysis.resultSchemaRevision ===
          IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION))
  );
}

/**
 * One more failure since the last operator retry. A retryable failure returns
 * to `pending` with backoff until the budget is spent; then, like any terminal
 * failure, the job and its derivative fail with the last error. An executor's
 * retryable flag cannot outlast the budget: a deterministic failure reported
 * as retryable would otherwise loop forever.
 */
async function settleImageProcessingFailure(
  tx: DrizzleTransaction,
  job: { id: string; derivativeId: string | null },
  input: {
    reason: string;
    retryable: boolean;
    set: Partial<typeof imageProcessingJob.$inferInsert>;
    retryAt?: SQL | Date;
  },
): Promise<boolean> {
  const execution = await externalJobClaim(
    tx,
    `image-processing:${job.id}`,
    undefined,
    true,
  );
  if (!execution) return false;
  if (!input.retryable) execution.attempts = execution.maxAttempts;
  await failJob(databaseForTransaction(tx), execution, new Error(input.reason));
  const retry = input.retryable && execution.attempts < execution.maxAttempts;
  const reason = input.reason;
  await tx
    .update(imageProcessingJob)
    .set({
      ...input.set,
      lastError: reason,
      state: retry ? "pending" : "failed",
      ...(retry ? {} : { completedAt: new Date() }),
    })
    .where(eq(imageProcessingJob.id, job.id));
  if (!retry && job.derivativeId)
    await tx
      .update(imageDerivative)
      .set({ status: "failed", failureReason: reason })
      .where(eq(imageDerivative.id, job.derivativeId));
  return retry;
}

async function adoptTerminalCompletion(
  tx: DrizzleTransaction,
  job: CompletionJob,
  input: CompletionInput,
): Promise<boolean> {
  const outcome = input.result.outcome;
  if (outcome.status === "completed") return false;
  const base = {
    attemptId: null,
    runtime: input.runtime ?? null,
    result: outcome,
  };
  if (outcome.status === "failed") {
    const retry = await settleImageProcessingFailure(tx, job, {
      reason: outcome.reason,
      retryable: outcome.retryable,
      set: base,
    });
    if (!retry && input.orphanOutputKey) {
      await tx
        .insert(imageProcessingOrphan)
        .values({
          key: input.orphanOutputKey,
          attemptId: input.result.attemptId,
          reason: outcome.reason,
        })
        .onConflictDoNothing();
    }
    return true;
  }
  await tx
    .update(imageProcessingJob)
    .set({
      ...base,
      state: "skipped",
      completedAt: sql`now()`,
      lastError: outcome.reason,
    })
    .where(eq(imageProcessingJob.id, job.id));
  if (job.derivativeId) {
    await tx
      .update(imageDerivative)
      .set({ status: "skipped", failureReason: outcome.reason })
      .where(eq(imageDerivative.id, job.derivativeId));
  }
  return true;
}

async function adoptSuccessfulCompletion(
  tx: DrizzleTransaction,
  job: CompletionJob,
  input: CompletionInput,
): Promise<boolean> {
  const outcome = input.result.outcome;
  if (outcome.status !== "completed") return false;
  if (outcome.kind === "subject_lift") {
    const verified = input.verifiedDerivative;
    if (!verified || !job.derivativeId) return false;
    await tx
      .update(imageDerivative)
      .set({
        status: "ready",
        contentType: verified.contentType,
        sha256: verified.sha256,
        width: verified.width,
        height: verified.height,
        failureReason: null,
      })
      .where(
        and(
          eq(imageDerivative.id, job.derivativeId),
          eq(imageDerivative.sourceContentHash, job.sourceContentHash),
          notDeleted(imageDerivative),
        ),
      );
  }
  const analysis = input.appleAnalysis ?? input.cloudAnalysis;
  if (analysis && outcome.kind === "describe_image") {
    await tx
      .insert(aiAnalysis)
      .values({
        entityKind: "image",
        entityId: job.imageId,
        feature: "image-description",
        provider: analysis.provider,
        model: analysis.model,
        promptVersion: String(analysis.promptRevision),
        resultSchemaRevision: analysis.resultSchemaRevision,
        inputFingerprint: analysis.inputFingerprint,
        result: outcome.description,
        runtime: input.runtime ?? null,
      })
      .onConflictDoNothing();
  }
  if (input.identificationAnalysis && outcome.kind === "identify_image") {
    const identification = input.identificationAnalysis;
    await tx
      .insert(aiAnalysis)
      .values({
        entityKind: "image",
        entityId: job.imageId,
        feature: "image-identification",
        provider: identification.provider,
        model: identification.model,
        promptVersion: String(identification.promptRevision),
        resultSchemaRevision: identification.resultSchemaRevision,
        inputFingerprint: identification.inputFingerprint,
        result: outcome.identification,
        runtime: input.runtime ?? null,
      })
      .onConflictDoNothing();
  }
  await tx
    .update(imageProcessingJob)
    .set({
      attemptId: null,
      runtime: input.runtime ?? null,
      result: outcome,
      state: "ready",
      completedAt: sql`now()`,
      lastError: null,
    })
    .where(eq(imageProcessingJob.id, job.id));
  return true;
}

/**
 * Adopt a result only while its original bytes and lease still match. A
 * redelivered completion, expired lease, deleted image, or replaced upload is
 * a harmless stale result — its object stays in the orphan ledger for cleanup.
 */
export async function completeImageProcessingJob(
  db: Database,
  input: CompletionInput,
): Promise<{ adopted: boolean; orphanKey: string | null }> {
  let settledPhotoRunId: string | null = null;
  const completion = await withTransaction(db, async (tx) => {
    const execution = await externalJobClaim(
      tx,
      `image-processing:${input.result.jobId}`,
      input.result.attemptId,
      true,
    );
    const [job] = await tx
      .select({
        id: imageProcessingJob.id,
        runId: imageProcessingJob.runId,
        imageId: sql<ImageId>`${imageProcessingJob.imageId}`,
        derivativeId: imageProcessingJob.derivativeId,
        kind: imageProcessingJob.kind,
        state: imageProcessingJob.state,
        attemptId: imageProcessingJob.attemptId,
        leaseValid: sql<boolean>`${Boolean(execution)}::boolean`,
        sourceContentHash: imageProcessingJob.sourceContentHash,
        processorRevision: imageProcessingJob.processorRevision,
        imageHash: image.sha256,
        imageStatus: image.status,
      })
      .from(imageProcessingJob)
      .innerJoin(
        image,
        and(eq(image.id, imageProcessingJob.imageId), notDeleted(image)),
      )
      .leftJoin(
        imageDerivative,
        and(
          eq(imageDerivative.id, imageProcessingJob.derivativeId),
          notDeleted(imageDerivative),
        ),
      )
      .where(eq(imageProcessingJob.id, input.result.jobId))
      .for("update", { of: [imageProcessingJob, image] });
    if (
      !canAdoptCompletion(job, input) ||
      !execution ||
      execution.leaseExpiresAt.getTime() <= Date.now()
    ) {
      const attempt = await tx.query.imageProcessingAttempt.findFirst({
        where: and(
          eq(imageProcessingAttempt.id, input.result.attemptId),
          eq(imageProcessingAttempt.jobId, input.result.jobId),
        ),
      });
      if (attempt && !["ready", "skipped", "failed"].includes(attempt.state)) {
        await recordImageProcessingEvent(tx, {
          jobId: attempt.jobId,
          eventKey: `${attempt.id}:rejected`,
          event: "completion.rejected",
          attempt: attempt.number,
          level: "debug",
          details: {
            reason: "Attempt, source, or lease no longer current",
            result: input.result.outcome,
            diagnostics: input.result.diagnostics ?? null,
          },
        });
      }
      return { adopted: false, orphanKey: null };
    }
    const adopted =
      (await adoptTerminalCompletion(tx, job, input)) ||
      (await adoptSuccessfulCompletion(tx, job, input));
    if (!adopted) return { adopted: false, orphanKey: null };
    const outcome = input.result.outcome;
    const recorded = await tx
      .update(imageProcessingAttempt)
      .set({
        state: outcome.status === "completed" ? "ready" : outcome.status,
        completedAt: sql`now()`,
        result: outcome,
        diagnostics: sql`coalesce(${imageProcessingAttempt.diagnostics}, '{}'::jsonb) || ${JSON.stringify({ runtime: input.runtime ?? null, device: input.result.diagnostics ?? null, validation: input.verifiedDerivative ? { outcome: "validated transparent PNG", ...input.verifiedDerivative } : input.orphanOutputKey ? { outcome: "rejected output" } : null })}::jsonb`,
        error: outcome.status === "completed" ? null : outcome.reason,
      })
      .where(eq(imageProcessingAttempt.id, input.result.attemptId))
      .returning({ id: imageProcessingAttempt.id });
    // A failure before any executor took the lease has no attempt row yet; it
    // still counts toward the retry limit and stays visible in history.
    if (!recorded.length && outcome.status === "failed")
      await insertImageProcessingAttempt(tx, {
        jobId: job.id,
        attemptId: input.result.attemptId,
        state: "failed",
        error: outcome.reason,
        result: outcome,
      });
    await recordImageProcessingEvent(tx, {
      jobId: job.id,
      eventKey: `${input.result.attemptId}:completed`,
      event: `execution.${outcome.status}`,
      level: outcome.status === "failed" ? "error" : "info",
      details: outcome,
    });
    if (outcome.status !== "failed") {
      const published = await publishJobPage(
        databaseForTransaction(tx),
        execution,
        {
          done: true,
          result: {
            outcome: outcome.status,
            attemptId: input.result.attemptId,
          },
        },
      );
      if (!published) throw new JobSupersededError();
    }
    if (outcome.status === "failed")
      await repositoryBeforeCommit(
        tx,
        async () => {
          if (execution.leaseExpiresAt.getTime() <= Date.now())
            throw new JobSupersededError();
        },
        { phase: "publication" },
      );
    await recordChange(tx, {
      kind: "projection",
      categories: ["image", "relatedData"],
      // Selected descriptions are inputs to image and attached-owner search documents.
      ...(job.kind === "describe_image"
        ? { refresh: ["search"] as const }
        : {}),
    });
    if (job.kind === "describe_image") settledPhotoRunId = job.runId;
    return { adopted: true, orphanKey: null };
  });
  // A settled description can make a photo Run ready to group (or need
  // attention); the advance runs after commit and never fails this write.
  if (settledPhotoRunId) {
    const { advancePhotoRunQuietly } =
      await import("~/server/domains/photo-import/repo/run/lifecycle");
    await advancePhotoRunQuietly(db, settledPhotoRunId);
  }
  return completion;
}

/** Claim orphan keys in a transaction before best-effort post-commit deletion. */
export async function claimImageProcessingOrphans(
  db: Database,
  limit: number,
): Promise<string[]> {
  return await withTransaction(db, async (tx) => {
    // Signed companion PUT URLs last five minutes. Retaining keys longer than
    // that prevents a suspended client from recreating an object after the
    // cleanup worker saw a temporary 404.
    const expiredBefore = sql`now() - ${PRESIGNED_URL_DEFAULT_EXPIRY_SECONDS + 60} * interval '1 second'`;
    const rows = await tx
      .select({ id: imageProcessingOrphan.id, key: imageProcessingOrphan.key })
      .from(imageProcessingOrphan)
      .where(
        and(
          lte(imageProcessingOrphan.createdAt, expiredBefore),
          ne(imageProcessingOrphan.reason, MAIL_ATTACHMENT_UPLOAD_REASON),
        ),
      )
      .orderBy(asc(imageProcessingOrphan.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    return rows.map((row) => row.key);
  });
}

export async function finalizeImageProcessingOrphans(
  db: Database,
  keys: readonly string[],
): Promise<void> {
  if (!keys.length) return;
  await getDb(db)
    .delete(imageProcessingOrphan)
    .where(inArray(imageProcessingOrphan.key, [...new Set(keys)]));
}

export async function saveImageDescriptionAnalysis(
  db: Database,
  input: {
    imageId: ImageId;
    provider: string;
    model: string;
    promptRevision: number;
    resultSchemaRevision: number;
    inputFingerprint: string;
    result: ImageDescriptionResult;
    runtime?: AiAnalysisRuntime;
  },
): Promise<void> {
  await getDb(db)
    .insert(aiAnalysis)
    .values({
      entityKind: "image",
      entityId: input.imageId,
      feature: "image-description",
      provider: input.provider,
      model: input.model,
      promptVersion: String(input.promptRevision),
      resultSchemaRevision: input.resultSchemaRevision,
      inputFingerprint: input.inputFingerprint,
      result: input.result,
      runtime: input.runtime ?? null,
    })
    .onConflictDoNothing();
  // The analysis identity retains the first response, including on provider retries.
  const result = await findCachedImageDescriptionAnalysis(db, {
    ...input,
    promptVersion: String(input.promptRevision),
  });
  if (!result)
    throw new Error("Persisted image description analysis is unavailable");
  const fingerprint = parseImageDescriptionInputFingerprint(
    input.inputFingerprint,
  );
  await publishAssessment(
    db,
    {
      publicationKey: `image-description:${input.imageId}:${input.inputFingerprint}:${input.provider}:${input.model}:${input.promptRevision}`,
      family: "image_description",
      subject: {
        kind: "image_description",
        entity: "image",
        recordId: input.imageId,
        contentHash: fingerprint?.sourceContentHash ?? null,
      },
      judgment: result.description,
      producer: {
        kind: "model",
        model: input.model,
        revision: String(input.promptRevision),
        runId: null,
        evaluationId: null,
      },
      fingerprint: fingerprint?.sourceContentHash ?? null,
      evidence: z.json().parse({
        inputFingerprint: input.inputFingerprint,
        result,
      }),
    },
    { suggestedValue: result.description },
  );
  await recordChange(db, { kind: "projection", categories: ["image"] });
}

/**
 * One resolver for image renderers. It never fetches, queues, or charges: a
 * transparent URL is usable only after the child row reached ready status for
 * the original's current content hash.
 */
export async function loadImageRepresentations(
  db: Database | DrizzleTransaction,
  shortcodes: readonly string[],
): Promise<Map<string, ImageRepresentations>> {
  if (!shortcodes.length) return new Map();
  const rows = await unwrapDb(db)
    .select({
      shortcode: image.shortcode,
      key: image.key,
      useOriginal: image.useOriginal,
      derivativeKey: imageDerivative.key,
    })
    .from(image)
    .leftJoin(
      imageDerivative,
      and(
        eq(imageDerivative.imageId, image.id),
        eq(imageDerivative.purpose, "transparent"),
        eq(imageDerivative.sourceContentHash, image.sha256),
        inArray(
          imageDerivative.processorRevision,
          compatibleSubjectLiftOutputs,
        ),
        eq(imageDerivative.status, "ready"),
        notDeleted(imageDerivative),
      ),
    )
    .where(
      and(
        inArray(image.shortcode, [...new Set(shortcodes)]),
        notDeleted(image),
      ),
    )
    .orderBy(
      asc(imageDerivative.processorRevision),
      asc(imageDerivative.createdAt),
    );
  return new Map(
    rows.map((row) => {
      const original = getR2PublicUrl(row.key);
      const transparent = row.derivativeKey
        ? getR2PublicUrl(row.derivativeKey)
        : null;
      return [
        row.shortcode,
        {
          original,
          transparent,
          preferred: !row.useOriginal && transparent ? transparent : original,
          preferredKind:
            !row.useOriginal && transparent ? "transparent" : "original",
        },
      ];
    }),
  );
}

export async function getImageProcessingReadProjection(
  db: Database,
  imageId: ImageId,
) {
  const source = await getDb(db).query.image.findFirst({
    where: and(eq(image.id, imageId), notDeleted(image)),
    columns: { shortcode: true, sha256: true },
  });
  if (!source) throw new Error("Image not found");
  const representations = (
    await loadImageRepresentations(db, [source.shortcode])
  ).get(source.shortcode);
  if (!representations) throw new Error("Image not found");
  const jobs = await getDb(db)
    .select({
      kind: imageProcessingJob.kind,
      state: imageProcessingJob.state,
      processorRevision: imageProcessingJob.processorRevision,
    })
    .from(imageProcessingJob)
    .where(
      and(
        eq(imageProcessingJob.imageId, imageId),
        eq(imageProcessingJob.sourceContentHash, source.sha256 ?? ""),
      ),
    )
    .orderBy(desc(imageProcessingJob.processorRevision));
  const cutout = await getDb(db)
    .select({ status: imageDerivative.status })
    .from(imageDerivative)
    .where(
      and(
        eq(imageDerivative.imageId, imageId),
        eq(imageDerivative.sourceContentHash, source.sha256 ?? ""),
        inArray(
          imageDerivative.processorRevision,
          compatibleSubjectLiftOutputs,
        ),
        notDeleted(imageDerivative),
      ),
    )
    .orderBy(
      desc(eq(imageDerivative.status, "ready")),
      desc(imageDerivative.processorRevision),
    )
    .limit(1);
  const history = await getDb(db)
    .select({
      provider: aiAnalysis.provider,
      model: aiAnalysis.model,
      promptVersion: aiAnalysis.promptVersion,
      resultSchemaRevision: aiAnalysis.resultSchemaRevision,
      inputFingerprint: aiAnalysis.inputFingerprint,
      result: aiAnalysis.result,
      runtime: aiAnalysis.runtime,
      createdAt: aiAnalysis.createdAt,
    })
    .from(aiAnalysis)
    .where(
      and(
        eq(aiAnalysis.entityKind, "image"),
        eq(aiAnalysis.entityId, imageId),
        eq(aiAnalysis.feature, "image-description"),
        notDeleted(aiAnalysis),
      ),
    )
    .orderBy(desc(aiAnalysis.createdAt));
  const toAnalysis = (entry: (typeof history)[number]) => {
    const result = imageDescriptionResult.safeParse(entry.result);
    const promptRevision = Number(entry.promptVersion);
    if (
      !result.success ||
      !Number.isInteger(promptRevision) ||
      !entry.resultSchemaRevision
    )
      return null;
    return {
      provider: entry.provider ?? "legacy",
      model: entry.model,
      promptRevision,
      resultSchemaRevision: entry.resultSchemaRevision,
      inputFingerprint: entry.inputFingerprint,
      result: result.data,
      runtime: imageDescriptionAnalysis.shape.runtime.parse(entry.runtime),
      createdAt: entry.createdAt.toISOString(),
      preferred: false,
    };
  };
  const candidates = history.flatMap((entry, rawIndex) => {
    const analysis = toAnalysis(entry);
    return analysis ? [{ rawIndex, analysis }] : [];
  });
  const analyses = candidates
    .filter((entry) => entry.rawIndex < 20)
    .map((entry) => entry.analysis);
  const isPreferred = (entry: (typeof analyses)[number]) => {
    const fingerprint = parseImageDescriptionInputFingerprint(
      entry.inputFingerprint,
    );
    return (
      fingerprint !== null &&
      isCurrentPreferredImageDescription(fingerprint, {
        sourceContentHash: source.sha256,
        provider: entry.provider,
        model: entry.model,
        promptRevision: entry.promptRevision,
        resultSchemaRevision: entry.resultSchemaRevision,
      })
    );
  };
  // Bounded history must not hide the preferred or available current-source result.
  const available = candidates.map((entry) => entry.analysis);
  const currentPreferred =
    available.find(isPreferred) ??
    available.find(
      (entry) => selectImageDescription([entry], null, source.sha256) !== null,
    );
  if (
    currentPreferred &&
    !analyses.some(
      (entry) =>
        entry.createdAt === currentPreferred.createdAt &&
        entry.inputFingerprint === currentPreferred.inputFingerprint,
    )
  ) {
    if (analyses.length >= 20) analyses.pop();
    analyses.push(currentPreferred);
  }
  const preferred = analyses.findIndex(isPreferred);
  if (preferred >= 0) analyses[preferred]!.preferred = true;
  const correction = await readConfirmedDescription(db, imageId);
  return {
    representations,
    status: {
      cutout: cutout[0]?.status ?? null,
      description:
        jobs.find(
          (job) =>
            job.kind === "describe_image" &&
            job.processorRevision === IMAGE_DESCRIPTION_PROCESSOR_REVISION,
        )?.state ?? null,
      identification:
        jobs.find(
          (job) =>
            job.kind === "identify_image" &&
            job.processorRevision === IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
        )?.state ?? null,
    },
    analyses,
    correction: correction
      ? {
          description: correction.description,
          confirmedAt: correction.confirmedAt.toISOString(),
        }
      : null,
  };
}

/** Release only the assigned live attempt; process death is still repaired by lease expiry. */
export async function releaseAssignedImageProcessingJob(
  db: Database,
  input: { jobId: string; attemptId: string; deviceId: string; userId: string },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const execution = await externalJobClaim(
      databaseForTransaction(tx),
      `image-processing:${input.jobId}`,
      input.attemptId,
      true,
    );
    if (!execution) return false;
    const [assignment] = await tx
      .select({
        executor: imageProcessingAttempt.executor,
        derivativeId: imageProcessingJob.derivativeId,
      })
      .from(imageProcessingJob)
      .innerJoin(
        imageProcessingAttempt,
        eq(imageProcessingAttempt.id, imageProcessingJob.attemptId),
      )
      .where(
        and(
          eq(imageProcessingJob.id, input.jobId),
          eq(imageProcessingJob.attemptId, input.attemptId),
          eq(imageProcessingJob.state, "leased"),
          eq(imageProcessingAttempt.assignedUserId, input.userId),
        ),
      )
      .limit(1)
      .for("update", { of: [imageProcessingJob] });
    if (
      assignment?.executor?.kind !== "device" ||
      assignment.executor.deviceId !== input.deviceId
    )
      return false;
    if (assignment.derivativeId) {
      const [output] = await tx
        .select({ key: imageDerivative.key })
        .from(imageDerivative)
        .where(eq(imageDerivative.id, assignment.derivativeId));
      if (output)
        await tx
          .insert(imageProcessingOrphan)
          .values({
            key: output.key,
            attemptId: input.attemptId,
            reason: "Background execution released",
          })
          .onConflictDoNothing();
    }
    await tx
      .update(imageProcessingAttempt)
      .set({
        state: "failed",
        completedAt: sql`now()`,
        error: "Background execution released",
      })
      .where(eq(imageProcessingAttempt.id, input.attemptId));
    await publishJobPage(databaseForTransaction(tx), execution, {
      done: false,
    });
    await tx
      .update(imageProcessingJob)
      .set({
        state: "pending",
        attemptId: null,
        lastError: "Background execution released",
      })
      .where(eq(imageProcessingJob.id, input.jobId));
    await recordImageProcessingEvent(tx, {
      jobId: input.jobId,
      eventKey: `${input.attemptId}:released`,
      event: "execution.released",
      level: "info",
      source: "device",
    });
    return true;
  });
}
