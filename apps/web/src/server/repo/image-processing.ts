import type { AiAnalysisRuntime } from "@cubby/schemas/ai";
import {
  parseEntityId,
  type ImageId,
  type RunId,
} from "@cubby/schemas/identifiers";
import {
  imageProcessingCompletedOutcome,
  imageDescriptionResult,
  imageDescriptionAnalysis,
  type ImageDescriptionResult,
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import type {
  ImageProcessingJobKind,
  ImageProcessingJobState,
  ImageProcessingResult,
} from "@cubby/schemas/image-processing";
import type { ImageRepresentations } from "@cubby/schemas/image-summary";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  imageDerivative,
  imageDescriptionCorrection,
  imageProcessingOrphan,
  imageProcessingJob,
  imageProcessingAttempt,
  imageProcessingSubmissionJob,
} from "~/server/db/image-processing-schema";
import { aiAnalysis, entityAttachment, image } from "~/server/db/schema";
import {
  isCurrentPreferredImageDescription,
  parseImageDescriptionInputFingerprint,
  preferredImageDescriptionPolicy,
} from "~/server/image-processing/description-policy";
import {
  getDb,
  unwrapDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { refreshDirectImageOwnerSearchDocuments } from "~/server/repo/search-document";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";
import {
  generateImageKey,
  PRESIGNED_URL_DEFAULT_EXPIRY_SECONDS,
} from "~/server/utils/s3";

import { recordImageProcessingEvent } from "./image-processing-history";

export const IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION = 1;
/** A label-only attachment is the sole reversible terminal cutout decision. */
const LABEL_ONLY_CUTOUT_SKIP_REASON =
  "Image is attached only as label evidence";

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

type JobIdentity = {
  imageId: ImageId;
  kind: ImageProcessingJobKind;
  sourceContentHash: string;
  processorRevision: number;
  /** The Run that requested this job, when the caller has one. */
  runId?: RunId | null;
};

const isAttachedOnlyAsLabel = async (
  tx: DrizzleTransaction,
  imageId: ImageId,
): Promise<boolean> => {
  const [attachments] = await tx
    .select({
      hasLabel: sql<boolean>`bool_or(${entityAttachment.purpose} = 'label')`,
      hasItem: sql<boolean>`bool_or(${entityAttachment.purpose} IS DISTINCT FROM 'label')`,
    })
    .from(entityAttachment)
    .where(
      and(eq(entityAttachment.imageId, imageId), notDeleted(entityAttachment)),
    );
  return attachments?.hasLabel === true && attachments.hasItem !== true;
};

export type ClaimedImageProcessingJob = {
  id: string;
  imageId: ImageId;
  kind: ImageProcessingJobKind;
  sourceContentHash: string;
  processorRevision: number;
  attempts: number;
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
      isNull(aiAnalysis.deletedAt),
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

  await getDb(db)
    .insert(imageProcessingJob)
    .values({
      ...input,
      derivativeId: input.derivativeId ?? null,
      runId: input.runId ?? null,
      state: "pending",
    })
    .onConflictDoNothing();

  const row = await getDb(db).query.imageProcessingJob.findFirst({
    where: and(
      eq(imageProcessingJob.imageId, input.imageId),
      eq(imageProcessingJob.kind, input.kind),
      eq(imageProcessingJob.sourceContentHash, input.sourceContentHash),
      eq(imageProcessingJob.processorRevision, input.processorRevision),
    ),
    columns: { id: true },
  });
  return row?.id ?? null;
}

export async function createTransparentDerivativeAndJob(
  db: Database,
  input: {
    imageId: ImageId;
    sourceContentHash: string;
    key: string;
    /** A manual reschedule may undo only the reversible label-only decision. */
    reviveLabelOnlySkip?: boolean;
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
        isNull(imageDerivative.deletedAt),
      ),
      columns: { id: true, status: true, failureReason: true },
    });
    if (!derivative) throw new Error("Image derivative was not persisted");

    await tx
      .insert(imageProcessingJob)
      .values({
        imageId: input.imageId,
        derivativeId: derivative.id,
        kind: "subject_lift",
        state: "pending",
        sourceContentHash: input.sourceContentHash,
        processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
        runId: input.runId ?? null,
      })
      .onConflictDoNothing();
    const job = await tx.query.imageProcessingJob.findFirst({
      where: and(
        eq(imageProcessingJob.imageId, input.imageId),
        eq(imageProcessingJob.kind, "subject_lift"),
        eq(imageProcessingJob.sourceContentHash, input.sourceContentHash),
        eq(
          imageProcessingJob.processorRevision,
          IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
        ),
      ),
      columns: { id: true, state: true, lastError: true },
    });
    if (!job) throw new Error("Image processing job was not persisted");
    if (
      input.reviveLabelOnlySkip &&
      job.state === "skipped" &&
      job.lastError === LABEL_ONLY_CUTOUT_SKIP_REASON &&
      derivative.status === "skipped" &&
      derivative.failureReason === LABEL_ONLY_CUTOUT_SKIP_REASON &&
      !(await isAttachedOnlyAsLabel(tx, input.imageId))
    ) {
      await tx
        .update(imageDerivative)
        .set({ status: "pending", failureReason: null })
        .where(eq(imageDerivative.id, derivative.id));
      await tx
        .update(imageProcessingJob)
        .set({
          state: "pending",
          attemptId: null,
          leaseExpiresAt: null,
          completedAt: null,
          nextAttemptAt: sql`now()`,
          lastError: null,
        })
        .where(eq(imageProcessingJob.id, job.id));
    }
    return { derivativeId: derivative.id, jobId: job.id };
  });
}

/** Expired leases are safe to retry because every completion must echo attemptId. */
export async function reclaimExpiredImageProcessingLeases(
  db: Database,
  clock?: Date,
): Promise<number> {
  const now = clock ?? sql`now()`;
  return withTransaction(db, async (tx) => {
    const expired = await tx
      .select({
        id: imageProcessingJob.id,
        attemptId: imageProcessingJob.attemptId,
        attempts: imageProcessingJob.attempts,
      })
      .from(imageProcessingJob)
      .where(
        and(
          eq(imageProcessingJob.state, "leased"),
          lte(imageProcessingJob.leaseExpiresAt, now),
        ),
      )
      .for("update");
    for (const job of expired) {
      if (job.attemptId)
        await tx
          .update(imageProcessingAttempt)
          .set({
            state: "expired",
            completedAt: now,
            error: "Execution lease expired",
          })
          .where(eq(imageProcessingAttempt.id, job.attemptId));
      await recordImageProcessingEvent(tx, {
        jobId: job.id,
        eventKey: `${job.attemptId}:expired`,
        event: "attempt.expired",
        attempt: job.attempts,
        level: "error",
      });
      await tx
        .update(imageProcessingJob)
        .set({
          state: "pending",
          attemptId: null,
          leaseExpiresAt: null,
          nextAttemptAt: now,
          lastError: "Execution lease expired",
        })
        .where(eq(imageProcessingJob.id, job.id));
    }
    return expired.length;
  });
}

/** Claim one job with a bounded lease. No HTTP path waits for device work. */
export async function claimImageProcessingJob(
  db: Database,
  input: {
    kinds: readonly ImageProcessingJobKind[];
    leaseMs: number;
    /** A queue wakeup must never lease an unrelated row. */
    jobId?: string;
  },
): Promise<ClaimedImageProcessingJob | null> {
  // Use the database clock for both eligibility and leases; worker clocks can drift.
  const now = sql`now()`;
  const leaseExpiresAt = sql`now() + ${input.leaseMs} * interval '1 millisecond'`;
  return await withTransaction(db, async (tx) => {
    // The policy is internal so a new caller cannot accidentally bypass pause.
    const { mayClaimImageProcessingJob } =
      await import("./image-processing-maintenance");
    if (!(await mayClaimImageProcessingJob(tx))) return null;
    const [candidate] = await tx
      .select({
        id: imageProcessingJob.id,
        imageId: imageProcessingJob.imageId,
        kind: imageProcessingJob.kind,
        sourceContentHash: imageProcessingJob.sourceContentHash,
        processorRevision: imageProcessingJob.processorRevision,
        attempts: imageProcessingJob.attempts,
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
          isNull(imageDerivative.deletedAt),
        ),
      )
      .where(
        and(
          input.jobId ? eq(imageProcessingJob.id, input.jobId) : undefined,
          inArray(imageProcessingJob.kind, [...input.kinds]),
          or(
            eq(imageProcessingJob.state, "pending"),
            eq(imageProcessingJob.state, "waiting_for_device"),
          ),
          lte(imageProcessingJob.nextAttemptAt, now),
        ),
      )
      .orderBy(
        asc(imageProcessingJob.nextAttemptAt),
        asc(imageProcessingJob.id),
      )
      .limit(1)
      .for("update", { of: [imageProcessingJob, image], skipLocked: true });
    if (!candidate) return null;

    // Product-image purpose belongs to the attachment, rather than the Image.
    // A shared source still needs a cutout when any live attachment is an item
    // (including a legacy null purpose). Only a confirmed label-only source is
    // terminal before we mint a device capability.
    if (candidate.kind === "subject_lift") {
      if (await isAttachedOnlyAsLabel(tx, candidate.imageId)) {
        const reason = LABEL_ONLY_CUTOUT_SKIP_REASON;
        await tx
          .update(imageProcessingJob)
          .set({
            state: "skipped",
            completedAt: now,
            attemptId: null,
            leaseExpiresAt: null,
            lastError: reason,
          })
          .where(eq(imageProcessingJob.id, candidate.id));
        if (candidate.derivativeId)
          await tx
            .update(imageDerivative)
            .set({ status: "skipped", failureReason: reason })
            .where(eq(imageDerivative.id, candidate.derivativeId));
        await recordImageProcessingEvent(tx, {
          jobId: candidate.id,
          eventKey: "dispatch:label-only",
          event: "dispatch.skipped_label_only",
          details: { reason },
        });
        return null;
      }
    }

    // A subject-lift job without a live output record must not send an upload
    // capability that can be adopted nowhere. Mark it terminal instead.
    if (candidate.kind === "subject_lift" && !candidate.derivativeKey) {
      await tx
        .update(imageProcessingJob)
        .set({
          state: "failed",
          completedAt: now,
          lastError: "Transparent derivative is unavailable",
        })
        .where(eq(imageProcessingJob.id, candidate.id));
      return null;
    }

    const attemptId = crypto.randomUUID();
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
    const [leased] = await tx
      .update(imageProcessingJob)
      .set({
        state: "leased",
        attemptId,
        leaseExpiresAt,
        dispatchedAt: now,
        attempts: sql`${imageProcessingJob.attempts} + 1`,
      })
      .where(eq(imageProcessingJob.id, candidate.id))
      .returning({ leaseExpiresAt: imageProcessingJob.leaseExpiresAt });
    if (!leased?.leaseExpiresAt)
      throw new Error("Image-processing lease was not persisted");
    await tx.insert(imageProcessingAttempt).values({
      id: attemptId,
      jobId: candidate.id,
      number: candidate.attempts + 1,
      submissionId: candidate.submissionId,
      state: "leased",
      diagnostics: {
        sourceContentHash: candidate.sourceContentHash,
        sourceKey: candidate.originalKey,
        inputAvailability: "recorded original",
        processorRevision: candidate.processorRevision,
        contentType: candidate.originalContentType,
      },
    });
    await recordImageProcessingEvent(tx, {
      jobId: candidate.id,
      eventKey: `${attemptId}:claimed`,
      event: "attempt.claimed",
      attempt: candidate.attempts + 1,
    });
    const { previousAttemptId: _previousAttemptId, ...claimed } = candidate;
    return {
      ...claimed,
      derivativeKey,
      attemptId,
      leaseExpiresAt: leased.leaseExpiresAt,
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
        isNull(imageDerivative.deletedAt),
      ),
    )
    .where(
      and(
        eq(imageProcessingJob.id, input.jobId),
        eq(imageProcessingJob.attemptId, input.attemptId),
        eq(imageProcessingJob.state, "leased"),
      ),
    )
    .limit(1);
  return row[0]?.key ?? null;
}

export async function getLeasedImageProcessingJobContext(
  db: Database,
  input: { jobId: string; attemptId: string },
): Promise<{
  imageId: ImageId;
  sourceShortcode: string;
  sourceContentHash: string;
  contentType: string;
} | null> {
  const rows = await getDb(db)
    .select({
      imageId: imageProcessingJob.imageId,
      sourceShortcode: image.shortcode,
      sourceContentHash: imageProcessingJob.sourceContentHash,
      contentType: image.contentType,
    })
    .from(imageProcessingJob)
    .innerJoin(
      image,
      and(eq(image.id, imageProcessingJob.imageId), notDeleted(image)),
    )
    .where(
      and(
        eq(imageProcessingJob.id, input.jobId),
        eq(imageProcessingJob.attemptId, input.attemptId),
        eq(imageProcessingJob.state, "leased"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function markImageProcessingWaitingForDevice(
  db: Database,
  input: { jobId: string; attemptId: string },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const rows = await tx
      .update(imageProcessingJob)
      .set({
        state: "waiting_for_device",
        attemptId: null,
        leaseExpiresAt: null,
        nextAttemptAt: sql`now() + interval '1 minute'`,
      })
      .where(
        and(
          eq(imageProcessingJob.id, input.jobId),
          eq(imageProcessingJob.attemptId, input.attemptId),
          eq(imageProcessingJob.state, "leased"),
        ),
      )
      .returning({ id: imageProcessingJob.id });
    if (rows.length) {
      await tx
        .update(imageProcessingAttempt)
        .set({ state: "waiting", completedAt: sql`now()` })
        .where(
          and(
            eq(imageProcessingAttempt.id, input.attemptId),
            eq(imageProcessingAttempt.state, "leased"),
          ),
        );
      await recordImageProcessingEvent(tx, {
        jobId: input.jobId,
        eventKey: `${input.attemptId}:waiting`,
        event: "dispatch.waiting",
      });
    }
  });
}

/** The current cloud decision gates companion cutout work; absent means wait. */
export async function getCurrentImageCutoutEligibility(
  db: Database,
  imageId: ImageId,
  sourceContentHash: string,
): Promise<"eligible" | "ineligible" | "review" | null> {
  const row = await getDb(db).query.imageProcessingJob.findFirst({
    where: and(
      eq(imageProcessingJob.imageId, imageId),
      eq(imageProcessingJob.kind, "describe_image"),
      eq(
        imageProcessingJob.processorRevision,
        IMAGE_DESCRIPTION_PROCESSOR_REVISION,
      ),
      eq(imageProcessingJob.sourceContentHash, sourceContentHash),
      eq(imageProcessingJob.state, "ready"),
    ),
    columns: { result: true },
    orderBy: [desc(imageProcessingJob.completedAt)],
  });
  const outcome = imageProcessingCompletedOutcome.safeParse(row?.result);
  return outcome.success && outcome.data.kind === "describe_image"
    ? outcome.data.description.cutoutEligibility
    : null;
}

/**
 * Retire a bounded page of jobs whose immutable source is gone before looking
 * for repair wakeups. Otherwise old pending rows sort ahead of every live job,
 * while the claim's source fence rejects them one at a time forever.
 */
async function skipObsoleteImageProcessingDispatchJobs(
  db: Database,
  limit: number,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    const obsolete = await tx
      .select({
        id: imageProcessingJob.id,
        attempts: imageProcessingJob.attempts,
      })
      .from(imageProcessingJob)
      .innerJoin(image, eq(image.id, imageProcessingJob.imageId))
      .where(
        and(
          inArray(imageProcessingJob.state, ["pending", "waiting_for_device"]),
          or(
            isNotNull(image.deletedAt),
            ne(image.status, "UPLOADED"),
            isNull(image.sha256),
            ne(image.sha256, imageProcessingJob.sourceContentHash),
          ),
        ),
      )
      .orderBy(
        asc(imageProcessingJob.nextAttemptAt),
        asc(imageProcessingJob.id),
      )
      .limit(limit)
      .for("update", { of: [imageProcessingJob, image], skipLocked: true });
    if (!obsolete.length) return;

    const ids = obsolete.map((job) => job.id);
    await tx
      .update(imageProcessingJob)
      .set({
        state: "skipped",
        attemptId: null,
        leaseExpiresAt: null,
        completedAt: sql`now()`,
        lastError: "Original image is no longer current",
      })
      .where(
        and(
          inArray(imageProcessingJob.id, ids),
          inArray(imageProcessingJob.state, ["pending", "waiting_for_device"]),
        ),
      );
    for (const job of obsolete) {
      await recordImageProcessingEvent(tx, {
        jobId: job.id,
        eventKey: "source-obsolete",
        event: "dispatch.skipped_obsolete_source",
        attempt: job.attempts,
        level: "info",
        details: { reason: "Original image is no longer current" },
      });
    }
  });
}

/** Bounded repair after a post-commit queue publication was missed. */
export async function findImageProcessingDispatchRepairs(
  db: Database,
  limit: number,
): Promise<string[]> {
  await skipObsoleteImageProcessingDispatchJobs(db, limit);
  const rows = await getDb(db)
    .select({ id: imageProcessingJob.id })
    .from(imageProcessingJob)
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
      or(
        eq(imageProcessingJob.state, "pending"),
        eq(imageProcessingJob.state, "waiting_for_device"),
      ),
    )
    .orderBy(asc(imageProcessingJob.nextAttemptAt), asc(imageProcessingJob.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Bounded maintenance retry; old result/runtime remains immutable history. */
export async function retryFailedImageProcessingJobs(
  db: Database,
  limit: number,
  options?: { imageId?: ImageId; submissionId?: string },
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
          or(
            and(
              eq(imageProcessingJob.kind, "subject_lift"),
              eq(
                imageProcessingJob.processorRevision,
                IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
              ),
            ),
            and(
              eq(imageProcessingJob.kind, "describe_image"),
              inArray(imageProcessingJob.processorRevision, [
                IMAGE_DESCRIPTION_PROCESSOR_REVISION,
                IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
              ]),
            ),
          ),
        ),
      )
      .orderBy(asc(imageProcessingJob.completedAt), asc(imageProcessingJob.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
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
        leaseExpiresAt: null,
        nextAttemptAt: sql`now()`,
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

type CompletionInput = {
  result: ImageProcessingResult;
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
    revisionMatches &&
    appleAnalysisMatches
  );
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
    leaseExpiresAt: null,
    runtime: input.runtime ?? null,
    result: outcome,
  };
  if (outcome.status === "failed") {
    await tx
      .update(imageProcessingJob)
      .set(
        outcome.retryable
          ? {
              ...base,
              state: "pending",
              nextAttemptAt: sql`now() + interval '1 minute'`,
              lastError: outcome.reason,
            }
          : {
              ...base,
              state: "failed",
              completedAt: sql`now()`,
              lastError: outcome.reason,
            },
      )
      .where(eq(imageProcessingJob.id, job.id));
    if (!outcome.retryable && job.derivativeId) {
      await tx
        .update(imageDerivative)
        .set({ status: "failed", failureReason: outcome.reason })
        .where(eq(imageDerivative.id, job.derivativeId));
    }
    if (!outcome.retryable && input.orphanOutputKey) {
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
          isNull(imageDerivative.deletedAt),
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
  await tx
    .update(imageProcessingJob)
    .set({
      attemptId: null,
      leaseExpiresAt: null,
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
  return await withTransaction(db, async (tx) => {
    const [job] = await tx
      .select({
        id: imageProcessingJob.id,
        imageId: imageProcessingJob.imageId,
        derivativeId: imageProcessingJob.derivativeId,
        kind: imageProcessingJob.kind,
        state: imageProcessingJob.state,
        attemptId: imageProcessingJob.attemptId,
        leaseValid: sql<boolean>`${imageProcessingJob.leaseExpiresAt} > now()`,
        sourceContentHash: imageProcessingJob.sourceContentHash,
        processorRevision: imageProcessingJob.processorRevision,
        imageHash: image.sha256,
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
          isNull(imageDerivative.deletedAt),
        ),
      )
      .where(eq(imageProcessingJob.id, input.result.jobId))
      .for("update", { of: [imageProcessingJob, image] });
    if (!canAdoptCompletion(job, input)) {
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
    await tx
      .update(imageProcessingAttempt)
      .set({
        state: outcome.status === "completed" ? "ready" : outcome.status,
        completedAt: sql`now()`,
        result: outcome,
        diagnostics: sql`coalesce(${imageProcessingAttempt.diagnostics}, '{}'::jsonb) || ${JSON.stringify({ runtime: input.runtime ?? null, device: input.result.diagnostics ?? null, validation: input.verifiedDerivative ? { outcome: "validated transparent PNG", ...input.verifiedDerivative } : input.orphanOutputKey ? { outcome: "rejected output" } : null })}::jsonb`,
        error: outcome.status === "completed" ? null : outcome.reason,
      })
      .where(eq(imageProcessingAttempt.id, input.result.attemptId));
    await recordImageProcessingEvent(tx, {
      jobId: job.id,
      eventKey: `${input.result.attemptId}:completed`,
      event: `execution.${outcome.status}`,
      level: outcome.status === "failed" ? "error" : "info",
      details: outcome,
    });
    return { adopted: true, orphanKey: null };
  });
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
      .where(lte(imageProcessingOrphan.createdAt, expiredBefore))
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
  await refreshDirectImageOwnerSearchDocuments(db, input.imageId);
}

export async function saveImageDescriptionCorrection(
  db: Database,
  input: { imageId: ImageId; description: string },
): Promise<void> {
  await withTransaction(db, async (tx) => {
    await tx
      .update(imageDescriptionCorrection)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(imageDescriptionCorrection.imageId, input.imageId),
          isNull(imageDescriptionCorrection.deletedAt),
        ),
      );
    await tx.insert(imageDescriptionCorrection).values(input);
  });
  await refreshDirectImageOwnerSearchDocuments(db, input.imageId);
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
        eq(
          imageDerivative.processorRevision,
          IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
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
        eq(
          imageDerivative.processorRevision,
          IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
        ),
        notDeleted(imageDerivative),
      ),
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
        isNull(aiAnalysis.deletedAt),
      ),
    )
    .orderBy(desc(aiAnalysis.createdAt))
    .limit(20);
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
  const analyses = history.flatMap((entry) => {
    const parsed = toAnalysis(entry);
    return parsed ? [parsed] : [];
  });
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
  // Keep history bounded but find the current cloud result independently: a
  // run of Apple evaluations or older source versions must not hide it.
  const currentCandidates = await getDb(db)
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
        eq(aiAnalysis.provider, preferredImageDescriptionPolicy.provider),
        eq(aiAnalysis.model, preferredImageDescriptionPolicy.model),
        eq(
          aiAnalysis.promptVersion,
          String(preferredImageDescriptionPolicy.promptRevision),
        ),
        eq(
          aiAnalysis.resultSchemaRevision,
          preferredImageDescriptionPolicy.resultSchemaRevision,
        ),
        isNull(aiAnalysis.deletedAt),
      ),
    )
    .orderBy(desc(aiAnalysis.createdAt));
  const currentPreferred = currentCandidates
    .map((entry) => toAnalysis(entry))
    .find((entry) => entry !== null && isPreferred(entry));
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
  const correction = await getDb(db).query.imageDescriptionCorrection.findFirst(
    {
      where: and(
        eq(imageDescriptionCorrection.imageId, imageId),
        isNull(imageDescriptionCorrection.deletedAt),
      ),
      columns: { description: true, confirmedAt: true },
    },
  );
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
