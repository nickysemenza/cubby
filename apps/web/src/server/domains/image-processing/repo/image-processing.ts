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
  imageProcessingJobState,
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
import { and, asc, desc, eq, gt, inArray, lte, ne, or, sql } from "drizzle-orm";
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
  deviceBackfillTurn,
  type DeviceAdmission,
  lockDeviceAdmission,
  recordDeviceAdmission,
  refuseDeviceAdmission,
} from "~/server/generic/jobs/repo/device-admission";
import {
  enqueueJob,
  claimJob,
  externalJobClaim,
  publishJobPage,
  failJob,
  releaseJobClaim,
  retryJobsNow,
  assertJobClaim,
  jobRunOwned,
  JobSupersededError,
  type JobClaim,
} from "~/server/generic/jobs/repo/jobs";
import { findOrCreateWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { imageJobDisplayStateSql } from "./image-job-state";
import {
  insertImageProcessingAttempt,
  recordImageProcessingEvent,
} from "./image-processing-history";
import {
  armDeviceWake,
  ringImageProcessingCompanionsAfterCommit,
} from "./image-processing-ring";

/** A server-side failure is retried later; image work never fails terminally. */
export const SERVER_FAILURE_RETRYABLE = true;

/** The universal Job owning one ImageProcessingJob's execution. */
export const imageProcessingJobKey = (id: string) => `image-processing:${id}`;

export type ImageProcessingLane = "image.cloud" | "image.device";

/**
 * Which executor runs a job, fixed by its identity: Apple devices run subject
 * lifts, Apple descriptions and the JPEG preparation an AVIF cloud
 * description needs; the server runs every other cloud call. Mirrored by the
 * lane split in `drizzle/0029_image_job_lanes.sql`.
 */
export function imageProcessingLane(job: {
  kind: ImageProcessingJobKind;
  processorRevision: number;
  contentType: string | null;
}): ImageProcessingLane {
  if (job.kind === "subject_lift") return "image.device";
  if (
    job.kind === "describe_image" &&
    (job.processorRevision === IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION ||
      job.contentType === "image/avif")
  )
    return "image.device";
  return "image.cloud";
}

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
  /** A device claim's fairness admission; null for cloud claims. */
  admission: DeviceAdmission | null;
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
    if (row.state === "pending")
      await enqueueImageProcessingExecution(databaseForTransaction(tx), row);
    return row;
  });
}

/**
 * The one enqueue of an open job's execution, in the caller's transaction.
 * Device work is parked for device pulls and rings connected companions after
 * commit; it is never claimed by the server drain.
 */
export async function enqueueImageProcessingExecution(
  db: Database,
  row: {
    id: string;
    imageId: string;
    kind: ImageProcessingJobKind;
    processorRevision: number;
    runId: RunId | null;
  },
) {
  const [source] = await getDb(db)
    .select({ contentType: image.contentType })
    .from(image)
    .where(eq(image.id, row.imageId));
  const lane = imageProcessingLane({
    ...row,
    contentType: source?.contentType ?? null,
  });
  await enqueueJob(db, {
    key: imageProcessingJobKey(row.id),
    kind: lane,
    subjectKind: "image",
    subjectId: row.imageId,
    input: { processingId: row.id },
    runId: row.runId,
  });
  if (lane === "image.device")
    await ringImageProcessingCompanionsAfterCommit(db);
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
 * Settle open work whose source image was removed or replaced, or whose
 * processor revision was superseded: the only moot endings image work has.
 * `jobId` scopes it to one row inside that row's own execution; otherwise a
 * bounded batch also completes the parked Jobs no executor will claim.
 */
export async function retireObsoleteImageProcessingJobs(
  db: Database,
  input: { jobId: string } | { limit: number },
): Promise<number> {
  const dbc = getDb(db);
  const scoped = "jobId" in input;
  const obsolete = and(
    eq(imageProcessingJob.state, "pending"),
    scoped ? eq(imageProcessingJob.id, input.jobId) : undefined,
    // includes-deleted: retire work whose source image was removed.
    sql`EXISTS (SELECT 1 FROM ${image} WHERE ${image.id}=${imageProcessingJob.imageId} AND (${obsoleteImageProcessingSource()} OR NOT ${currentImageProcessingProcessor()}))`,
  );
  const batch = scoped
    ? null
    : (
        await dbc
          .select({ id: imageProcessingJob.id })
          .from(imageProcessingJob)
          .where(obsolete)
          .orderBy(asc(imageProcessingJob.id))
          .limit(input.limit)
          .for("update", { skipLocked: true })
      ).map((row) => row.id);
  if (batch?.length === 0) return 0;
  const result = {
    rows: await dbc
      .update(imageProcessingJob)
      .set({
        state: "skipped",
        completedAt: new Date(),
        lastError: "Image source or processor is obsolete",
      })
      .where(batch ? inArray(imageProcessingJob.id, batch) : obsolete)
      .returning({ id: imageProcessingJob.id }),
  };
  const ids = result.rows.map((row) => row.id);
  if (!ids.length) return 0;
  if (!scoped)
    await dbc
      .update(durableJob)
      .set({
        state: "completed",
        generation: sql`${durableJob.generation} + 1`,
        result: { outcome: "skipped" },
        waitReason: null,
        waitUntil: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(durableJob.key, ids.map(imageProcessingJobKey)),
          inArray(durableJob.state, ["queued", "retry_wait", "running"]),
        ),
      );
  await recordChange(db, {
    kind: "projection",
    categories: ["imageJob"],
    refresh: ["quality"],
  });
  return ids.length;
}

/**
 * Give a subject lift whose output record disappeared a fresh pending
 * derivative instead of failing it; the claim then mints its output key.
 */
async function rebuildTransparentDerivative(
  tx: DrizzleTransaction,
  job: { id: string; imageId: string; sourceContentHash: string },
) {
  await tx
    .insert(imageDerivative)
    .values({
      imageId: parseEntityId("image", job.imageId),
      purpose: "transparent",
      status: "pending",
      key: generateImageKey(`image-${job.imageId}-transparent.png`),
      sourceContentHash: job.sourceContentHash,
      processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
    })
    .onConflictDoNothing();
  const [live] = await tx
    .select({ id: imageDerivative.id, key: imageDerivative.key })
    .from(imageDerivative)
    .where(
      and(
        eq(imageDerivative.imageId, parseEntityId("image", job.imageId)),
        eq(imageDerivative.purpose, "transparent"),
        eq(imageDerivative.sourceContentHash, job.sourceContentHash),
        eq(
          imageDerivative.processorRevision,
          IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
        ),
        notDeleted(imageDerivative),
      ),
    );
  if (!live) throw new Error("Transparent derivative was not rebuilt");
  await tx
    .update(imageProcessingJob)
    .set({ derivativeId: live.id })
    .where(eq(imageProcessingJob.id, job.id));
  return live;
}

/**
 * Claim one job with a bounded lease. No HTTP path waits for device work.
 * Expired leases are safe to reclaim because every completion must echo
 * the Job's lease token as its attemptId; reclaiming one is not an attempt.
 */
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
    /** A device pull prefers work whose last attempt ran on another device. */
    deviceId?: string;
  },
): Promise<ClaimedImageProcessingJob | null> {
  // Candidate selection uses the same due-time clock as the shared Job claim.
  const now = new Date();
  const currentExecution = currentJobExecution();
  return await withTransaction(db, async (tx) => {
    if (currentExecution) {
      if (
        !input.jobId ||
        currentExecution.claim.kind !== "image.cloud" ||
        currentExecution.claim.key !== imageProcessingJobKey(input.jobId)
      )
        throw new Error(
          "Image processing requires its own universal Job claim",
        );
      await assertJobClaim(
        databaseForTransaction(tx),
        currentExecution.claim,
        "update",
      );
      await retireObsoleteImageProcessingJobs(databaseForTransaction(tx), {
        jobId: input.jobId,
      });
    }
    // Device admission keeps the drain's priorities: an active Run's work
    // leads, but backfill keeps its reserved share of pulls.
    const devicePull =
      !currentExecution && input.processorRevisions !== undefined;
    // Device pulls take their turns one at a time: the lane's admission row
    // stays locked until this claim commits its class.
    const priorStreak = devicePull
      ? await lockDeviceAdmission(databaseForTransaction(tx))
      : 0;
    const backfillTurn = devicePull && deviceBackfillTurn(priorStreak);
    // The internal policy keeps claims within the device’s supported job kinds.
    // A retry prefers a different device than the one its last attempt ran
    // on, within the class whose turn it is; a lone device still takes its
    // own retries.
    const ranOnThisDevice = input.deviceId
      ? sql<boolean>`EXISTS (SELECT 1 FROM ${imageProcessingAttempt} a
          WHERE a.id = ${imageProcessingJob.attemptId}
            AND a.executor->>'deviceId' = ${input.deviceId})`
      : undefined;
    const candidates = () =>
      tx
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
          runOwned: jobRunOwned(),
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
            eq(imageProcessingJob.state, "pending"),
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
              : and(
                  // Devices claim parked device work directly, honoring its
                  // backoff; an expired lease is claimable at once.
                  input.processorRevisions
                    ? eq(durableJob.kind, "image.device")
                    : undefined,
                  or(
                    and(
                      inArray(durableJob.state, ["queued", "retry_wait"]),
                      lte(durableJob.availableAt, now),
                    ),
                    and(
                      eq(durableJob.state, "running"),
                      lte(durableJob.leaseExpiresAt, now),
                    ),
                  ),
                ),
          ),
        )
        .orderBy(
          ...(devicePull
            ? [backfillTurn ? asc(jobRunOwned()) : desc(jobRunOwned())]
            : []),
          ...(ranOnThisDevice ? [asc(ranOnThisDevice)] : []),
          asc(durableJob.availableAt),
          asc(imageProcessingJob.id),
        )
        .limit(1);
    const lock = (query: ReturnType<typeof candidates>) =>
      currentExecution
        ? query.for("update", { of: [imageProcessingJob, image] })
        : query.for("update", {
            of: [imageProcessingJob, image],
            skipLocked: true,
          });
    const [candidate] = await lock(candidates());
    if (!candidate) return null;

    const execution =
      currentExecution?.claim ??
      (await claimJob(
        databaseForTransaction(tx),
        candidate.executionId,
        input.leaseMs,
      ));
    if (!execution) return null;
    const admission = devicePull
      ? await recordDeviceAdmission(
          databaseForTransaction(tx),
          candidate.runOwned,
          priorStreak,
        )
      : null;
    // A device lease can lapse while every device idles; the wake rings then.
    if (execution.kind === "image.device")
      await armDeviceWake(databaseForTransaction(tx));
    let derivativeId = candidate.derivativeId;
    if (candidate.kind === "subject_lift" && !candidate.derivativeKey)
      derivativeId = (await rebuildTransparentDerivative(tx, candidate)).id;

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
    if (candidate.kind === "subject_lift" && derivativeId) {
      if (candidate.derivativeKey)
        await tx
          .insert(imageProcessingOrphan)
          .values({
            key: candidate.derivativeKey,
            attemptId: candidate.previousAttemptId,
            reason: "Superseded image-processing output key",
          })
          .onConflictDoNothing();
      await tx
        .update(imageDerivative)
        .set({ key: derivativeKey!, status: "pending", failureReason: null })
        .where(eq(imageDerivative.id, derivativeId));
    }
    // The Job owns execution state; the row records only its current attempt.
    await tx
      .update(imageProcessingJob)
      .set({ attemptId, dispatchedAt: new Date() })
      .where(eq(imageProcessingJob.id, candidate.id));
    if (candidate.kind === "subject_lift" && derivativeId)
      await recordChange(tx, {
        kind: "projection",
        categories: ["image", "imageJob"],
        refresh: ["quality"],
      });
    const {
      previousAttemptId: _previousAttemptId,
      executionId: _executionId,
      runOwned: _runOwned,
      ...claimed
    } = candidate;
    return {
      ...claimed,
      derivativeId,
      imageId: parseEntityId("image", claimed.imageId),
      derivativeKey,
      attemptId,
      leaseExpiresAt: execution.leaseExpiresAt,
      admission,
    };
  });
}

/**
 * The attempt still owns its Job: the lease token is unchanged. An expired
 * lease no newer claim replaced still belongs to it, so a late result is
 * adopted rather than dropped; a reclaim replaces the token atomically.
 */
const attemptOwnsExecution = (attemptId: string) =>
  sql<boolean>`EXISTS (SELECT 1 FROM "Job" j WHERE j.key='image-processing:' || ${imageProcessingJob.id}::text AND j.state=${jobState.enum.running} AND j."leaseToken"=${attemptId}::uuid)`;

/** Read the one output key bound to the current attempt before validating its bytes. */
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
        eq(imageProcessingJob.state, "pending"),
        attemptOwnsExecution(input.attemptId),
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
        eq(imageProcessingJob.state, "pending"),
        attemptOwnsExecution(input.attemptId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Hand a claimed attempt back without counting it: the server could not hand
 * the work over, or a device let it go. `delayMs` keeps a hand-off that keeps
 * failing from spinning; the recorded cause stays on the row.
 */
export async function releaseImageProcessingLease(
  db: Database,
  input: {
    jobId: string;
    attemptId: string;
    reason: string;
    delayMs?: number;
    event: "dispatch.released" | "execution.released";
    source?: "server" | "device";
    /**
     * The fairness class of a device claim the server could not hand over;
     * the release undoes its admission so a refused backfill stays owed.
     */
    refusedAdmission?: DeviceAdmission;
  },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const execution = await externalJobClaim(
      tx,
      imageProcessingJobKey(input.jobId),
      input.attemptId,
      true,
      { lateAdoption: true },
    );
    if (!execution) return false;
    const [job] = await tx
      .select({ derivativeId: imageProcessingJob.derivativeId })
      .from(imageProcessingJob)
      .where(
        and(
          eq(imageProcessingJob.id, input.jobId),
          eq(imageProcessingJob.attemptId, input.attemptId),
          eq(imageProcessingJob.state, "pending"),
        ),
      )
      .for("update");
    if (!job) return false;
    if (job.derivativeId) {
      const [output] = await tx
        .select({ key: imageDerivative.key })
        .from(imageDerivative)
        .where(eq(imageDerivative.id, job.derivativeId));
      if (output)
        await tx
          .insert(imageProcessingOrphan)
          .values({
            key: output.key,
            attemptId: input.attemptId,
            reason: input.reason,
          })
          .onConflictDoNothing();
    }
    await tx
      .update(imageProcessingAttempt)
      .set({ state: "released", completedAt: sql`now()`, error: input.reason })
      .where(
        and(
          eq(imageProcessingAttempt.id, input.attemptId),
          eq(imageProcessingAttempt.state, "running"),
        ),
      );
    await releaseJobClaim(databaseForTransaction(tx), execution, {
      availableAt: new Date(Date.now() + (input.delayMs ?? 0)),
    });
    // Released device work goes to another companion: ring at once, and
    // through the wake once a delayed release comes due.
    if (execution.kind === "image.device") {
      await armDeviceWake(databaseForTransaction(tx));
      if (!input.delayMs) await ringImageProcessingCompanionsAfterCommit(tx);
    }
    await recordImageProcessingEvent(tx, {
      jobId: input.jobId,
      eventKey: `${input.attemptId}:released`,
      event: input.event,
      level: input.delayMs ? "error" : "info",
      source: input.source ?? "server",
      details: { reason: input.reason },
    });
    if (input.refusedAdmission && execution.kind === "image.device")
      await refuseDeviceAdmission(
        databaseForTransaction(tx),
        input.refusedAdmission,
      );
    return true;
  });
}

/**
 * Retry now: an image's open jobs become due immediately, backoff cleared and
 * prior errors kept. Every job stays open until a result or a moot ending.
 */
export async function retryImageProcessingNow(
  db: Database,
  options: {
    imageId: ImageId;
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
          // `failed` is a legacy terminal state the migration reopened for
          // current processors; any left over is reopened here too.
          inArray(imageProcessingJob.state, ["pending", "failed"]),
          eq(imageProcessingJob.imageId, options.imageId),
          options.kinds
            ? inArray(imageProcessingJob.kind, [...options.kinds])
            : undefined,
          currentImageProcessingProcessor(),
        ),
      )
      .orderBy(asc(imageProcessingJob.id))
      .for("update", { skipLocked: true });
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    await tx
      .update(imageProcessingJob)
      .set({
        state: "pending",
        completedAt: null,
        ...(options.submissionId ? { submissionId: options.submissionId } : {}),
      })
      .where(inArray(imageProcessingJob.id, ids));
    if (options.submissionId)
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
    const transactionDb = databaseForTransaction(tx);
    const reopened = await tx
      .select({
        id: imageProcessingJob.id,
        imageId: imageProcessingJob.imageId,
        kind: imageProcessingJob.kind,
        processorRevision: imageProcessingJob.processorRevision,
        runId: imageProcessingJob.runId,
      })
      .from(imageProcessingJob)
      .where(inArray(imageProcessingJob.id, ids));
    // Executions missing since a legacy failure are recreated in their lane.
    for (const row of reopened)
      await enqueueImageProcessingExecution(transactionDb, row);
    await retryJobsNow(
      transactionDb,
      inArray(durableJob.key, ids.map(imageProcessingJobKey)),
    );
    await recordChange(tx, {
      kind: "projection",
      categories: ["imageJob"],
      refresh: ["quality"],
    });
    return ids;
  });
}

/** A newer Apple build may succeed where an older one failed: due again now. */
export const retryBackingOffDeviceWork = (db: Database) =>
  retryJobsNow(
    db,
    and(
      eq(durableJob.kind, "image.device"),
      eq(durableJob.state, "retry_wait"),
    )!,
  );

/** Open rows whose execution is missing or stopped: work no executor would reach. */
const strandedImageWork =
  () => sql<boolean>`${imageProcessingJob.state} = ${imageProcessingJobState.enum.pending}
  AND NOT EXISTS (SELECT 1 FROM "Job" dj WHERE dj.key = 'image-processing:' || "ImageProcessingJob".id::text
    AND dj.state IN (${jobState.enum.queued}, ${jobState.enum.retry_wait}, ${jobState.enum.running}))`;

/** Open image rows without a live execution: the watchdog's disagreement count. */
export async function countStrandedImageProcessing(db: Database) {
  const [row] = await getDb(db)
    .select({ count: sql<number>`count(*)::int` })
    .from(imageProcessingJob)
    .where(strandedImageWork());
  return row?.count ?? 0;
}

/**
 * Self-healing for image execution, run by the queue watchdog in bounded
 * batches: retire moot work, reopen legacy terminal or leased rows, and give
 * every open row a live Job in its lane. Image work is never abandoned, so a
 * stopped execution of open work is always a bug to repair, not a decision.
 */
export async function repairImageProcessingExecution(
  db: Database,
  limit: number,
) {
  const retired = await retireObsoleteImageProcessingJobs(db, { limit });
  // Rows a pre-cutover writer left leased or device-waiting are open work.
  const reopened = await getDb(db)
    .update(imageProcessingJob)
    .set({ state: "pending", completedAt: null })
    .where(
      inArray(
        imageProcessingJob.id,
        getDb(db)
          .select({ id: imageProcessingJob.id })
          .from(imageProcessingJob)
          .where(
            inArray(imageProcessingJob.state, ["leased", "waiting_for_device"]),
          )
          .limit(limit),
      ),
    )
    .returning({ id: imageProcessingJob.id });
  const stranded = await getDb(db)
    .select({
      id: imageProcessingJob.id,
      imageId: imageProcessingJob.imageId,
      kind: imageProcessingJob.kind,
      processorRevision: imageProcessingJob.processorRevision,
      runId: imageProcessingJob.runId,
    })
    .from(imageProcessingJob)
    .where(strandedImageWork())
    .orderBy(asc(imageProcessingJob.id))
    .limit(limit);
  if (stranded.length) {
    const keys = stranded.map((row) => imageProcessingJobKey(row.id));
    await retryJobsNow(
      db,
      and(
        inArray(durableJob.key, keys),
        inArray(durableJob.state, ["failed", "cancelled"]),
      )!,
    );
    // A finished or paused execution of open work restarts too.
    await getDb(db)
      .update(durableJob)
      .set({
        state: "queued",
        attempts: 0,
        generation: sql`${durableJob.generation} + 1`,
        availableAt: new Date(),
        waitReason: null,
        waitUntil: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(durableJob.key, keys),
          inArray(durableJob.state, ["completed", "paused"]),
        ),
      );
    for (const row of stranded) await enqueueImageProcessingExecution(db, row);
  }
  return {
    retired,
    reopened: reopened.length,
    restarted: stranded.length,
    more:
      retired >= limit || reopened.length >= limit || stranded.length >= limit,
  };
}

/**
 * A result that unblocks an image's other work (a prepared rendition) brings
 * its waiting jobs forward. Failure backoff is left alone.
 */
export async function bringImageProcessingForward(
  db: Database,
  imageId: ImageId,
) {
  await getDb(db)
    .update(durableJob)
    .set({ availableAt: new Date(), waitReason: null, waitUntil: null })
    .where(
      and(
        eq(durableJob.subjectKind, "image"),
        eq(durableJob.subjectId, imageId),
        inArray(durableJob.kind, ["image.cloud", "image.device"]),
        eq(durableJob.state, "queued"),
        eq(durableJob.waitReason, "device"),
      ),
    );
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
    job.state === "pending" &&
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
 * One more reported failure. Image work is never abandoned: every failure,
 * including one its executor calls non-retryable, waits out capped
 * exponential backoff and runs again, keeping its cause on the row. After
 * `JOB_NEEDS_ATTENTION_ATTEMPTS` failures it also shows as needing attention.
 */
async function settleImageProcessingFailure(
  tx: DrizzleTransaction,
  job: { id: string },
  input: {
    reason: string;
    set: Partial<typeof imageProcessingJob.$inferInsert>;
    execution: JobClaim;
  },
): Promise<void> {
  await failJob(
    databaseForTransaction(tx),
    input.execution,
    new Error(input.reason),
  );
  // The backoff ends while devices may idle; the wake rings them then.
  if (input.execution.kind === "image.device")
    await armDeviceWake(databaseForTransaction(tx));
  await tx
    .update(imageProcessingJob)
    .set({ ...input.set, lastError: input.reason })
    .where(eq(imageProcessingJob.id, job.id));
}

async function adoptFailedCompletion(
  tx: DrizzleTransaction,
  job: CompletionJob,
  input: CompletionInput,
  execution: JobClaim,
): Promise<boolean> {
  const outcome = input.result.outcome;
  if (outcome.status !== "failed") return false;
  // The failed attempt keeps its id on the row so the retry can prefer
  // another device; its Job token is gone, so it can no longer adopt.
  await settleImageProcessingFailure(tx, job, {
    reason: outcome.reason,
    set: { runtime: input.runtime ?? null, result: outcome },
    execution,
  });
  if (input.orphanOutputKey)
    await tx
      .insert(imageProcessingOrphan)
      .values({
        key: input.orphanOutputKey,
        attemptId: input.result.attemptId,
        reason: outcome.reason,
      })
      .onConflictDoNothing();
  return true;
}

/**
 * An executor's `skipped` (no_subject, not_suitable, unsupported_format) is
 * its verdict on one attempt, not a moot ending: only the server ends work
 * as moot (deletion, replacement, supersession, policy exclusion, in
 * `retireObsoleteImageProcessingJobs`). It is recorded as a retryable
 * failure that keeps its reason code, so the work backs off, runs again, and
 * asks for attention after repeated failures like any other failure.
 */
function reportedSkipAsFailure(input: CompletionInput): CompletionInput {
  const outcome = input.result.outcome;
  if (outcome.status !== "skipped") return input;
  const failed = {
    status: "failed" as const,
    retryable: true,
    reason: outcome.reason,
  };
  return {
    ...input,
    result: { ...input.result, outcome: { ...failed, kind: outcome.kind } },
  };
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
  reported: CompletionInput,
): Promise<{ adopted: boolean; orphanKey: string | null }> {
  const input = reportedSkipAsFailure(reported);
  let settledPhotoRunId: string | null = null;
  const completion = await withTransaction(db, async (tx) => {
    // A result after lease expiry is still adopted while no newer attempt
    // has claimed the Job (the token is unchanged).
    const execution = await externalJobClaim(
      tx,
      imageProcessingJobKey(input.result.jobId),
      input.result.attemptId,
      true,
      { lateAdoption: true },
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
    if (!canAdoptCompletion(job, input) || !execution) {
      const attempt = await tx.query.imageProcessingAttempt.findFirst({
        where: and(
          eq(imageProcessingAttempt.id, input.result.attemptId),
          eq(imageProcessingAttempt.jobId, input.result.jobId),
        ),
      });
      if (attempt && !["ready", "skipped", "failed"].includes(attempt.state)) {
        const outcome = input.result.outcome;
        // A newer attempt owns the work; a late failure still lands in this
        // attempt's history instead of vanishing. A released attempt keeps
        // its release, which the device itself reported.
        if (outcome.status === "failed" && attempt.state !== "released")
          await tx
            .update(imageProcessingAttempt)
            .set({
              state: "failed",
              completedAt: sql`now()`,
              result: outcome,
              error: outcome.reason,
            })
            .where(eq(imageProcessingAttempt.id, attempt.id));
        await recordImageProcessingEvent(tx, {
          jobId: attempt.jobId,
          eventKey: `${attempt.id}:rejected`,
          event: "completion.rejected",
          attempt: attempt.number,
          level: outcome.status === "failed" ? "error" : "debug",
          details: {
            reason: "Attempt, source, or lease no longer current",
            result: outcome,
            diagnostics: input.result.diagnostics ?? null,
          },
        });
      }
      return { adopted: false, orphanKey: null };
    }
    const adopted =
      (await adoptFailedCompletion(tx, job, input, execution)) ||
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
    await recordChange(tx, {
      kind: "projection",
      categories: ["image", "imageJob", "relatedData"],
      // Selected descriptions are inputs to image and attached-owner search documents.
      refresh:
        job.kind === "describe_image"
          ? (["quality", "search"] as const)
          : (["quality"] as const),
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
      state: imageJobDisplayStateSql(),
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
          owner: correction.owner,
        }
      : null,
  };
}

/** The device-assigned attempt that still owns the job, for release and renewal. */
async function deviceAssignment(
  tx: DrizzleTransaction,
  input: { jobId: string; attemptId: string; deviceId: string; userId: string },
) {
  const [assignment] = await tx
    .select({
      state: imageProcessingJob.state,
      attemptId: imageProcessingJob.attemptId,
      executor: imageProcessingAttempt.executor,
      assignedUserId: imageProcessingAttempt.assignedUserId,
    })
    .from(imageProcessingJob)
    .leftJoin(
      imageProcessingAttempt,
      and(
        eq(imageProcessingAttempt.id, input.attemptId),
        eq(imageProcessingAttempt.jobId, imageProcessingJob.id),
      ),
    )
    .where(eq(imageProcessingJob.id, input.jobId))
    .limit(1)
    .for("update", { of: [imageProcessingJob] });
  if (!assignment) return { status: "obsolete" as const };
  if (assignment.state !== "pending") return { status: "obsolete" as const };
  return assignment.attemptId === input.attemptId &&
    assignment.assignedUserId === input.userId &&
    assignment.executor?.kind === "device" &&
    assignment.executor.deviceId === input.deviceId
    ? { status: "assigned" as const }
    : { status: "lost" as const };
}

/**
 * A device stopped before finishing. Release is never an attempt: the job is
 * due again at once, and its next claim prefers another device. A release
 * after lease expiry still counts while no newer attempt replaced it.
 */
export async function releaseAssignedImageProcessingJob(
  db: Database,
  input: { jobId: string; attemptId: string; deviceId: string; userId: string },
): Promise<boolean> {
  const assigned = await withTransaction(db, async (tx) =>
    deviceAssignment(tx, input),
  );
  if (assigned.status !== "assigned") return false;
  return releaseImageProcessingLease(db, {
    jobId: input.jobId,
    attemptId: input.attemptId,
    reason: "Background execution released",
    event: "execution.released",
    source: "device",
  });
}

/** The device lease each renewal extends to. */
const DEVICE_LEASE_RENEWAL_MS = 60_000;

/**
 * A device heartbeat: extend the attempt's Job lease by 60 s while it still
 * owns the job. An expired lease no newer attempt replaced is renewed too,
 * matching late completion adoption. The command deadline is this lease.
 */
export async function renewAssignedImageProcessingLease(
  db: Database,
  input: { jobId: string; attemptId: string; deviceId: string; userId: string },
): Promise<
  | { ok: true; leaseExpiresAt: string }
  | { ok: false; reason: "lease_lost" | "job_obsolete" }
> {
  return withTransaction(db, async (tx) => {
    const execution = await externalJobClaim(
      tx,
      imageProcessingJobKey(input.jobId),
      input.attemptId,
      true,
      { lateAdoption: true },
    );
    const assigned = await deviceAssignment(tx, input);
    if (assigned.status === "obsolete")
      return { ok: false as const, reason: "job_obsolete" as const };
    if (!execution || assigned.status !== "assigned")
      return { ok: false as const, reason: "lease_lost" as const };
    const [source] = await tx
      .select({ id: image.id })
      .from(image)
      .innerJoin(imageProcessingJob, eq(imageProcessingJob.imageId, image.id))
      .where(
        and(
          eq(imageProcessingJob.id, input.jobId),
          notDeleted(image),
          eq(image.status, ImageStatus.enum.UPLOADED),
          eq(image.sha256, imageProcessingJob.sourceContentHash),
          currentImageProcessingProcessor(),
        ),
      );
    if (!source) return { ok: false as const, reason: "job_obsolete" as const };
    const [renewed] = await tx
      .update(durableJob)
      .set({
        leaseExpiresAt: new Date(Date.now() + DEVICE_LEASE_RENEWAL_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(durableJob.id, execution.id),
          eq(durableJob.state, "running"),
          eq(durableJob.leaseToken, input.attemptId),
          eq(durableJob.generation, execution.generation),
        ),
      )
      .returning({ leaseExpiresAt: durableJob.leaseExpiresAt });
    if (!renewed?.leaseExpiresAt)
      return { ok: false as const, reason: "lease_lost" as const };
    return {
      ok: true as const,
      leaseExpiresAt: renewed.leaseExpiresAt.toISOString(),
    };
  });
}
