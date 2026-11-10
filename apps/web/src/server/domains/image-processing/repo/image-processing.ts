import type { AiAnalysisRuntime } from "@cubby/schemas/ai";
import {
  parseEntityId,
  type ImageId,
  type ImageJobId,
  type DeviceId,
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
  imageProcessingSource,
} from "@cubby/schemas/image-processing";
import type {
  ImageProcessingCommand,
  ImageProcessingJobKind,
  ImageProcessingJobState,
  ImageProcessingTerminalResult as ImageProcessingResult,
} from "@cubby/schemas/image-processing";
import type { ImageRepresentations } from "@cubby/schemas/image-summary";
import { runStatus, VISIBLE_RUN_PURPOSES } from "@cubby/schemas/run-fields";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  generateImageKey,
  PRESIGNED_URL_DEFAULT_EXPIRY_SECONDS,
} from "~/server/clients/s3";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type ImageReadScope,
  imageScopeEmpty,
} from "~/server/db/computed/image-read-scope";
import {
  getDb,
  isTransaction,
  unwrapDb,
  notDeleted,
  withTransaction,
  withTransactionOn,
  withTransactionDatabase,
  databaseForTransaction,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  imageDerivative,
  imageProcessingOrphan,
  imageProcessingJob,
  imageProcessingAttempt,
  imageProcessingSubmissionJob,
} from "~/server/db/image-processing-schema";
import { aiAnalysis, image } from "~/server/db/schema";
import {
  isCurrentPreferredImageDescription,
  parseImageDescriptionInputFingerprint,
} from "~/server/domains/image-processing/repo/description-policy";
import {
  imageRepresentationRowsSql,
  imageRepresentationRow,
  imageRepresentationsFromRows,
} from "~/server/domains/image-processing/repo/image-representations";
import {
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_IDENTIFICATION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
} from "~/server/domains/image-processing/repo/processor-policy";
import { readConfirmedDescription } from "~/server/domains/image/repo/image-description-read";
import { MAIL_ATTACHMENT_UPLOAD_REASON } from "~/server/domains/mail/repo/mail-attachment-uploads";
import { recordChange } from "~/server/generic/changes/repo/change";
import { JobSupersededError } from "~/server/generic/jobs/errors";
import { findOrCreateWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  imageJobClaimable,
  imageJobDisplayStateSql,
  type ImageProcessingLane,
} from "./image-job-state";
import {
  insertImageProcessingAttempt,
  recordImageProcessingEvent,
} from "./image-processing-history";
import {
  parkedDeviceWork,
  ringDeviceWorkAt,
  ringImageProcessingCompanions,
  ringImageProcessingCompanionsAfterCommit,
} from "./image-processing-ring";

/** Doorbell readers address records by shortcode, while workers hold storage UUIDs. */
async function imageProcessingRecordChanges(
  db: Database | DrizzleTransaction,
  jobIds: readonly (typeof imageProcessingJob.$inferSelect.id)[],
  imageIds: readonly ImageId[] = [],
) {
  const dbc = unwrapDb(db);
  return {
    imageJob:
      jobIds.length > 200
        ? null
        : jobIds.length
          ? (
              await dbc
                .select({ shortcode: imageProcessingJob.shortcode })
                .from(imageProcessingJob)
                .where(inArray(imageProcessingJob.id, [...jobIds]))
            ).map((row) => row.shortcode)
          : [],
    image:
      imageIds.length > 200
        ? null
        : imageIds.length
          ? (
              await dbc
                .select({ shortcode: image.shortcode })
                .from(image)
                .where(inArray(image.id, [...imageIds]))
            ).map((row) => row.shortcode)
          : [],
  };
}

/** A server-side failure is retried later; image work never fails terminally. */
export const SERVER_FAILURE_RETRYABLE = true;

/** Failure backoff: image work waits ever longer and is never abandoned. */
const IMAGE_BACKOFF = { baseMs: 30_000, maxMs: 24 * 60 * 60_000 };
const imageRetryDelayMs = (failures: number) =>
  Math.min(
    IMAGE_BACKOFF.maxMs,
    IMAGE_BACKOFF.baseMs * 2 ** Math.max(0, failures - 1),
  );

/**
 * Which executor runs a job, fixed by its identity: Apple devices run subject
 * lifts, Apple descriptions and the JPEG preparation an AVIF cloud
 * description needs; the server runs every other cloud call.
 */
function imageProcessingLane(job: {
  kind: ImageProcessingJobKind;
  processorRevision: number;
  contentType: string | null;
}): ImageProcessingLane {
  if (job.kind === "subject_lift") return "device";
  if (
    job.kind === "describe_image" &&
    (job.processorRevision === IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION ||
      job.contentType === "image/avif")
  )
    return "device";
  return "cloud";
}

// This policy revision changes eligibility, not the cutout format or algorithm.
export const compatibleSubjectLiftOutputs = [
  1,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
];

const negativeSubjectLiftReasons = ["no_subject", "not_suitable"] as const;

const retainedNegativeSubjectLift = () =>
  and(
    eq(imageProcessingJob.kind, "subject_lift"),
    inArray(sql`${imageProcessingJob.result}->>'status'`, [
      "skipped",
      "failed",
    ]),
    inArray(
      sql`${imageProcessingJob.result}->>'reason'`,
      negativeSubjectLiftReasons,
    ),
  );

const currentImageProcessingProcessor = () => sql<boolean>`(
  (${imageProcessingJob.kind} = ${imageProcessingJobKind.enum.subject_lift}
    AND ${imageProcessingJob.processorRevision} = ${IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION})
  OR (${imageProcessingJob.kind} = ${imageProcessingJobKind.enum.identify_image}
    AND ${imageProcessingJob.processorRevision} = ${IMAGE_IDENTIFICATION_PROCESSOR_REVISION})
  OR (${imageProcessingJob.kind} = ${imageProcessingJobKind.enum.describe_image}
    AND ${imageProcessingJob.processorRevision} IN (${IMAGE_DESCRIPTION_PROCESSOR_REVISION}, ${IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION}))
)`;

/**
 * Source types a device command can carry. Device work on any other type
 * (a GIF, say) is type-excluded: its command would fail validation on every
 * pull, so it settles as skipped instead of holding a lease forever.
 */
const DEVICE_SOURCE_TYPES = imageProcessingSource.shape.contentType.options;

const obsoleteImageProcessingSource = () => sql<boolean>`(
  ${image.deletedAt} IS NOT NULL OR ${image.status} <> ${ImageStatus.enum.UPLOADED}
  OR ${image.sha256} IS NULL OR ${image.sha256} <> ${imageProcessingJob.sourceContentHash}
  OR (${image.contentType} NOT IN (${sql.join(
    DEVICE_SOURCE_TYPES.map((type) => sql`${type}`),
    sql`, `,
  )}) AND ${imageProcessingJob.lane} = ${"device"})
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
  id: ImageJobId;
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

/**
 * One image-processing transaction for a service-owned sequence of repo
 * steps; inside another, a savepoint. A device hand-off runs its claim,
 * assignment and release in one.
 */
export async function withImageProcessingTransaction<T>(
  db: Database,
  operation: (transactionDb: Database) => Promise<T>,
): Promise<T> {
  return withTransactionDatabase(db, operation);
}

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
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          and(
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
        ),
    },
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
): Promise<ImageJobId | null> {
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
    const [source] = await tx
      .select({ contentType: image.contentType })
      .from(image)
      .where(eq(image.id, values.imageId));
    const lane = imageProcessingLane({
      ...values,
      contentType: source?.contentType ?? null,
    });
    const { row } = await findOrCreateWithShortcode(tx, "imageJob", {
      where: and(
        eq(imageProcessingJob.imageId, values.imageId),
        eq(imageProcessingJob.kind, values.kind),
        eq(imageProcessingJob.sourceContentHash, values.sourceContentHash),
        eq(imageProcessingJob.processorRevision, values.processorRevision),
      ),
      // Due on the claimers' clock, not the database's.
      values: () => ({
        ...values,
        lane,
        runAt: new Date(),
        state: "pending" as const,
      }),
    });
    if (row.state === "pending" && row.lane === "device")
      await ringImageProcessingCompanionsAfterCommit(tx);
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
): Promise<{ derivativeId: string; jobId: ImageJobId } | null> {
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
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(
              eq(imageDerivative.imageId, input.imageId),
              eq(imageDerivative.purpose, "transparent"),
              eq(imageDerivative.sourceContentHash, input.sourceContentHash),
              eq(
                imageDerivative.processorRevision,
                IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
              ),
            ),
          ),
      },
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
 * Settle open work whose source image was removed or replaced, whose device
 * work has a type no device command carries, or whose processor revision was
 * superseded: the only moot endings image work has. `jobId` scopes it to one
 * row about to be claimed; otherwise it takes a bounded batch.
 */
export async function retireObsoleteImageProcessingJobs(
  db: Database,
  input: { jobId: ImageJobId } | { limit: number },
): Promise<number> {
  const dbc = getDb(db);
  const scoped = "jobId" in input;
  const obsolete = and(
    inArray(imageProcessingJob.state, ["pending", "failed"]),
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
        leaseUntil: null,
        lastError: sql`coalesce(${imageProcessingJob.lastError}, 'Image source, type or processor is obsolete')`,
      })
      .where(batch ? inArray(imageProcessingJob.id, batch) : obsolete)
      .returning({ id: imageProcessingJob.id }),
  };
  const ids = result.rows.map((row) => row.id);
  if (!ids.length) return 0;
  await recordChange(db, {
    kind: "projection",
    categories: ["imageJob"],
    changes: await imageProcessingRecordChanges(db, ids),
  });
  return ids.length;
}

/**
 * Give a subject lift whose output record disappeared a fresh pending
 * derivative instead of failing it; the claim then mints its output key.
 */
async function rebuildTransparentDerivative(
  tx: DrizzleTransaction,
  job: { id: ImageJobId; imageId: ImageId; sourceContentHash: string },
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
      ),
    );
  if (!live) throw new Error("Transparent derivative was not rebuilt");
  await tx
    .update(imageProcessingJob)
    .set({ derivativeId: live.id })
    .where(eq(imageProcessingJob.id, job.id));
  return live;
}

/** One device hand-off transaction's bounded candidates and what it already handed off. */
export type DeviceImageClaimBatch = {
  candidateLimit: number;
  candidateIds?: ImageJobId[];
  handedOffIds: ImageJobId[];
};

/**
 * Concurrent device pulls take turns, holding this lock until the transaction
 * that hands their batch over ends. A skip-locked pull would otherwise come back
 * empty and wait for the next ring while rows it could take sit locked.
 */
export async function lockDevicePulls(db: Database) {
  await getDb(db).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('image-device-pull', 0))`,
  );
}

/** An active, member-visible Run's image work leads the claim order. */
const imageRunOwned = () =>
  sql<boolean>`(${imageProcessingJob.runId} IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Run" r WHERE r.id = ${imageProcessingJob.runId}
      AND r.status = ${runStatus.enum.running}
      AND r.purpose IN (${sql.join(
        VISIBLE_RUN_PURPOSES.map((purpose) => sql`${purpose}`),
        sql`, `,
      )})
      AND ${notDeleted("r")}))`;

/** Cloud rows an executor may take now, oldest first. */
export const dueCloudImageJobs = async (db: Database, limit: number) =>
  (
    await getDb(db)
      .select({ id: imageProcessingJob.id })
      .from(imageProcessingJob)
      .where(
        and(
          eq(imageProcessingJob.lane, "cloud"),
          imageJobClaimable(new Date()),
        ),
      )
      .orderBy(asc(imageProcessingJob.runAt), asc(imageProcessingJob.id))
      .limit(limit)
  ).map((row): ImageJobId => row.id);

/** Permit selection: cloud work is due when a row is claimable now; Run-owned rows are demand. */
export const cloudImageDue = (unit: string) =>
  sql`SELECT ${unit}::text AS unit, coalesce(bool_or(${imageRunOwned()}), false) AS demand,
      min(${imageProcessingJob.runAt}) AS since
    FROM ${imageProcessingJob}
    WHERE ${eq(imageProcessingJob.lane, "cloud")} AND ${imageJobClaimable(new Date())}
    HAVING count(*) > 0`;

/** When the next open cloud row comes due or its lease lapses. */
export const cloudImageNext = () =>
  sql`SELECT min(coalesce(${imageProcessingJob.leaseUntil}, ${imageProcessingJob.runAt}))
    FROM ${imageProcessingJob}
    WHERE ${eq(imageProcessingJob.lane, "cloud")} AND ${eq(imageProcessingJob.state, "pending")}`;

/** Throws `JobSupersededError` once this attempt no longer holds a live lease on its row. */
export async function assertImageLeaseHeld(
  db: Database,
  claim: { id: ImageJobId; attemptId: string },
) {
  const [held] = await getDb(db)
    .select({ id: imageProcessingJob.id })
    .from(imageProcessingJob)
    .where(
      and(
        eq(imageProcessingJob.id, claim.id),
        eq(imageProcessingJob.attemptId, claim.attemptId),
        eq(imageProcessingJob.state, "pending"),
        sql`${imageProcessingJob.leaseUntil} > clock_timestamp()`,
      ),
    );
  if (!held) throw new JobSupersededError();
}

/**
 * Claim one job with a bounded lease. No HTTP path waits for device work.
 * Expired leases are safe to reclaim because every completion must echo
 * the row's attemptId; a reclaim counts as a failure, so a crash loop keeps
 * backing off and shows as needing attention.
 */
export async function claimImageProcessingJob(
  db: Database,
  input: {
    kinds: readonly ImageProcessingJobKind[];
    leaseMs: number;
    /** The cloud drain claims the one row it selected. */
    jobId?: ImageJobId;
    /**
     * A lease recovery reclaims only this lapsed attempt: once any executor
     * reclaimed or settled the row, its attempt changed and nothing is claimed.
     */
    attemptId?: string;
    /** Device pulls can execute only declared processor revisions, never cloud jobs. */
    processorRevisions?: readonly number[];
    /** A normalization-capable device may prepare cloud AVIF input, never other cloud jobs. */
    allowAvifNormalization?: boolean;
    /** A device pull prefers work whose last attempt ran on another device. */
    deviceId?: string;
    /** The batch shares its transaction and rings once before committing. */
    deviceBatch?: DeviceImageClaimBatch;
  },
): Promise<ClaimedImageProcessingJob | null> {
  const now = new Date();
  const client = getDb(db);
  return await withTransactionOn(
    input.deviceBatch && isTransaction(client) ? client : db,
    async (tx) => {
      if (input.jobId)
        await retireObsoleteImageProcessingJobs(databaseForTransaction(tx), {
          jobId: input.jobId,
        });
      // An active Run's work leads a device pull. A retry prefers a different
      // device than the one its last attempt ran on; a lone device still takes
      // its own retries.
      const devicePull = input.processorRevisions !== undefined;
      const ranOnThisDevice = input.deviceId
        ? sql<boolean>`EXISTS (SELECT 1 FROM ${imageProcessingAttempt} a
          WHERE a.id = ${imageProcessingJob.attemptId}
            AND a.executor->>'deviceId' = ${input.deviceId})`
        : undefined;
      const candidates = (limit = 1, candidateIds?: readonly ImageJobId[]) =>
        tx
          .select({
            id: imageProcessingJob.id,
            imageId: imageProcessingJob.imageId,
            kind: imageProcessingJob.kind,
            sourceContentHash: imageProcessingJob.sourceContentHash,
            processorRevision: imageProcessingJob.processorRevision,
            previousAttemptId: imageProcessingJob.attemptId,
            previousLease: imageProcessingJob.leaseUntil,
            lane: imageProcessingJob.lane,
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
            and(eq(imageDerivative.id, imageProcessingJob.derivativeId)),
          )
          .where(
            and(
              input.jobId ? eq(imageProcessingJob.id, input.jobId) : undefined,
              input.attemptId
                ? eq(imageProcessingJob.attemptId, input.attemptId)
                : undefined,
              input.deviceBatch?.handedOffIds.length
                ? notInArray(
                    imageProcessingJob.id,
                    input.deviceBatch.handedOffIds,
                  )
                : undefined,
              candidateIds
                ? inArray(imageProcessingJob.id, [...candidateIds])
                : undefined,
              inArray(imageProcessingJob.kind, [...input.kinds]),
              imageJobClaimable(now),
              currentImageProcessingProcessor(),
              devicePull ? eq(imageProcessingJob.lane, "device") : undefined,
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
            ),
          )
          .orderBy(
            ...(devicePull ? [desc(imageRunOwned())] : []),
            ...(ranOnThisDevice ? [asc(ranOnThisDevice)] : []),
            asc(imageProcessingJob.runAt),
            asc(imageProcessingJob.id),
          )
          .limit(limit)
          // An exact-attempt recovery waits for the row instead of skipping it:
          // a skipped lapsed attempt would otherwise wait for the hourly cron.
          .for(
            "update",
            input.attemptId
              ? { of: [imageProcessingJob, image] }
              : { of: [imageProcessingJob, image], skipLocked: true },
          );
      const batch = input.deviceBatch;
      if (
        batch &&
        batch.candidateLimit > 0 &&
        batch.candidateIds === undefined
      ) {
        // Rank once at household scale, then re-check the bounded identities for every claim.
        // The retry budget bounds the page even when output reservation refuses candidates.
        batch.candidateIds = (await candidates(batch.candidateLimit)).map(
          (candidate) => candidate.id,
        );
      }
      const [candidate] = await candidates(1, batch?.candidateIds);
      if (!candidate) return null;

      const attemptId = crypto.randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + input.leaseMs);
      // A device lease can lapse while every device idles; the ring covers it.
      if (candidate.lane === "device" && !input.deviceBatch)
        await ringDeviceWorkAt(tx, leaseExpiresAt);
      let derivativeId = candidate.derivativeId;
      if (candidate.kind === "subject_lift" && !candidate.derivativeKey)
        derivativeId = (await rebuildTransparentDerivative(tx, candidate)).id;

      if (candidate.previousAttemptId)
        await tx
          .update(imageProcessingAttempt)
          .set({
            state: "expired",
            completedAt: new Date(),
            error: "Image job lease expired",
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
      await tx
        .update(imageProcessingJob)
        .set({
          attemptId,
          dispatchedAt: now,
          leaseUntil: leaseExpiresAt,
          waitReason: null,
          ...(candidate.previousLease
            ? { failures: sql`${imageProcessingJob.failures} + 1` }
            : {}),
        })
        .where(eq(imageProcessingJob.id, candidate.id));
      // Every claim changes the displayed job status (Pending → Leased), and
      // open image screens rely on this ring instead of polling.
      await recordChange(tx, {
        kind: "projection",
        categories: ["image", "imageJob"],
        ringFromBackground: true,
        changes: await imageProcessingRecordChanges(
          tx,
          [candidate.id],
          [parseEntityId("image", candidate.imageId)],
        ),
      });
      const {
        previousAttemptId: _previousAttemptId,
        previousLease: _previousLease,
        lane: _lane,
        ...claimed
      } = candidate;
      return {
        ...claimed,
        derivativeId,
        imageId: parseEntityId("image", claimed.imageId),
        derivativeKey,
        attemptId,
        leaseExpiresAt,
      };
    },
  );
}

/**
 * Preparation may outlast an early lease. The transaction still owns the row locks, so unchanged
 * attempts can be re-armed together immediately before commit without counting another service.
 */
export async function finalizeCompanionImageLeases(
  db: Database,
  input: {
    claims: readonly Pick<ImageProcessingCommand, "jobId" | "attemptId">[];
    leaseMs: number;
  },
): Promise<Date> {
  const now = new Date();
  const expires = new Date(now.getTime() + input.leaseMs);
  if (!input.claims.length) return expires;
  const renewed = await getDb(db)
    .update(imageProcessingJob)
    .set({ leaseUntil: expires })
    .where(
      and(
        eq(imageProcessingJob.state, "pending"),
        isNotNull(imageProcessingJob.leaseUntil),
        or(
          ...input.claims.map((claim) =>
            and(
              eq(imageProcessingJob.id, claim.jobId),
              eq(imageProcessingJob.attemptId, claim.attemptId),
            ),
          ),
        ),
      ),
    )
    .returning({ id: imageProcessingJob.id });
  if (renewed.length !== input.claims.length)
    throw new Error(
      "Companion image batch lost a prepared lease before hand-off",
    );
  return expires;
}

/**
 * The attempt still owns its row: its id is unchanged and a lease is held. An
 * expired lease no newer claim replaced still belongs to it, so a late result is
 * adopted rather than dropped; a reclaim replaces the id atomically.
 */
const attemptOwnsLease = () => isNotNull(imageProcessingJob.leaseUntil);

/** Read the one output key bound to the current attempt before validating its bytes. */
export async function getLeasedImageProcessingOutputKey(
  db: Database,
  input: { jobId: ImageJobId; attemptId: string },
): Promise<string | null> {
  const row = await getDb(db)
    .select({ key: imageDerivative.key })
    .from(imageProcessingJob)
    .innerJoin(
      imageDerivative,
      and(eq(imageDerivative.id, imageProcessingJob.derivativeId)),
    )
    .where(
      and(
        eq(imageProcessingJob.id, input.jobId),
        eq(imageProcessingJob.attemptId, input.attemptId),
        eq(imageProcessingJob.state, "pending"),
        attemptOwnsLease(),
      ),
    )
    .limit(1);
  return row[0]?.key ?? null;
}

export async function getLeasedImageProcessingJobContext(
  db: Database,
  input: { jobId: ImageJobId; attemptId: string },
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
        attemptOwnsLease(),
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
    jobId: ImageJobId;
    attemptId: string;
    reason: string;
    delayMs?: number;
    event: "dispatch.released" | "execution.released";
    source?: "server" | "device";
  },
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const [job] = await tx
      .select({
        derivativeId: imageProcessingJob.derivativeId,
        lane: imageProcessingJob.lane,
        imageId: imageProcessingJob.imageId,
      })
      .from(imageProcessingJob)
      .where(
        and(
          eq(imageProcessingJob.id, input.jobId),
          eq(imageProcessingJob.attemptId, input.attemptId),
          eq(imageProcessingJob.state, "pending"),
          attemptOwnsLease(),
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
    const runAt = new Date(Date.now() + (input.delayMs ?? 0));
    await tx
      .update(imageProcessingJob)
      .set({ leaseUntil: null, waitReason: null, runAt })
      .where(eq(imageProcessingJob.id, input.jobId));
    // The displayed status returns from Leased to Pending; rings replace polling.
    await recordChange(tx, {
      kind: "projection",
      categories: ["image", "imageJob"],
      ringFromBackground: true,
      changes: await imageProcessingRecordChanges(
        tx,
        [input.jobId],
        [parseEntityId("image", job.imageId)],
      ),
    });
    // Released device work goes to another companion: ring at once, or once
    // a delayed release comes due.
    if (job.lane === "device") {
      if (input.delayMs) await ringDeviceWorkAt(tx, runAt);
      else await ringImageProcessingCompanionsAfterCommit(tx);
    }
    await recordImageProcessingEvent(tx, {
      jobId: input.jobId,
      eventKey: `${input.attemptId}:released`,
      event: input.event,
      level: input.delayMs ? "error" : "info",
      source: input.source ?? "server",
      details: { reason: input.reason },
    });
    return true;
  });
}

/**
 * Retry now: an image's open jobs become due immediately, backoff cleared and
 * prior errors kept. Deterministic failures reopen only on this explicit retry.
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
        state: imageProcessingJob.state,
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
          // A member can retry retained deterministic failures after fixing their cause.
          or(
            inArray(imageProcessingJob.state, ["pending", "failed"]),
            and(
              eq(imageProcessingJob.state, "skipped"),
              retainedNegativeSubjectLift(),
            ),
          ),
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
        // Keep the negative evidence, but detach its settled attempt so maintenance cannot
        // mistake this explicit retry for legacy work still waiting for policy settlement.
        attemptId: sql`CASE WHEN ${retainedNegativeSubjectLift()}
          AND ${imageProcessingJob.leaseUntil} IS NULL
          THEN NULL ELSE ${imageProcessingJob.attemptId} END`,
        // Backoff and waits clear; a held lease keeps running.
        runAt: new Date(),
        waitReason: null,
        failures: sql`CASE WHEN ${imageProcessingJob.leaseUntil} IS NULL THEN 0 ELSE ${imageProcessingJob.failures} END`,
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
    await ringImageProcessingCompanionsAfterCommit(tx);
    await recordChange(tx, {
      kind: "projection",
      categories: ["imageJob"],
      changes: await imageProcessingRecordChanges(tx, ids),
    });
    return ids;
  });
}

/** A newer Apple build may succeed where an older one failed: due again now. */
export async function retryBackingOffDeviceWork(db: Database) {
  await getDb(db)
    .update(imageProcessingJob)
    .set({ runAt: new Date(), failures: 0 })
    .where(
      and(
        eq(imageProcessingJob.state, "pending"),
        eq(imageProcessingJob.lane, "device"),
        isNull(imageProcessingJob.leaseUntil),
        isNull(imageProcessingJob.waitReason),
        gt(imageProcessingJob.failures, 0),
      ),
    );
}

/** Settle retained negative cutout evidence without executing it again or rewriting history. */
async function settleRetainedNegativeSubjectLifts(
  db: Database,
  limit: number,
): Promise<number> {
  return withTransaction(db, async (tx) => {
    const rows = await tx
      .select({
        id: imageProcessingJob.id,
        imageId: imageProcessingJob.imageId,
      })
      .from(imageProcessingJob)
      .innerJoin(
        image,
        and(eq(image.id, imageProcessingJob.imageId), notDeleted(image)),
      )
      .innerJoin(
        imageProcessingAttempt,
        and(
          eq(imageProcessingAttempt.id, imageProcessingJob.attemptId),
          eq(imageProcessingAttempt.jobId, imageProcessingJob.id),
          inArray(imageProcessingAttempt.state, ["failed", "skipped"]),
          eq(
            sql`${imageProcessingAttempt.result}->>'reason'`,
            sql`${imageProcessingJob.result}->>'reason'`,
          ),
        ),
      )
      .where(
        and(
          eq(imageProcessingJob.state, "pending"),
          notDeleted(imageProcessingJob),
          retainedNegativeSubjectLift(),
          eq(
            imageProcessingJob.processorRevision,
            IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
          ),
          eq(image.sha256, imageProcessingJob.sourceContentHash),
          eq(image.status, ImageStatus.enum.UPLOADED),
          isNull(imageProcessingJob.leaseUntil),
        ),
      )
      .orderBy(asc(imageProcessingJob.id))
      .limit(limit)
      .for("update", {
        of: [imageProcessingJob, image],
        skipLocked: true,
      });
    if (!rows.length) return 0;
    const ids = rows.map((row) => row.id);
    await tx
      .update(imageDerivative)
      .set({
        status: "skipped",
        failureReason: sql`${imageProcessingJob.result}->>'reason'`,
      })
      .from(imageProcessingJob)
      .where(
        and(
          inArray(imageProcessingJob.id, ids),
          eq(imageDerivative.id, imageProcessingJob.derivativeId),
          eq(
            imageDerivative.sourceContentHash,
            imageProcessingJob.sourceContentHash,
          ),
          ne(imageDerivative.status, "ready"),
        ),
      );
    await tx
      .update(imageProcessingJob)
      .set({
        state: "skipped",
        attemptId: null,
        completedAt: sql`now()`,
        lastError: null,
      })
      .where(inArray(imageProcessingJob.id, ids));
    await recordChange(tx, {
      kind: "projection",
      categories: ["image", "imageJob", "relatedData"],
      ringFromBackground: true,
      changes: await imageProcessingRecordChanges(
        tx,
        ids,
        rows.map((row) => row.imageId),
      ),
    });
    return rows.length;
  });
}

/**
 * Self-healing for image execution, run by recurring maintenance in bounded
 * batches: settle retained negative cutouts, retire moot work, reopen legacy
 * leased rows and ring for any parked work that came due. Image work is never
 * abandoned, and every open row is claimable from its own columns.
 */
export async function repairImageProcessingExecution(
  db: Database,
  limit: number,
) {
  const retired = await retireObsoleteImageProcessingJobs(db, { limit });
  const negativesSettled = await settleRetainedNegativeSubjectLifts(db, limit);
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
  if ((await parkedDeviceWork(db, new Date())).due)
    await ringImageProcessingCompanions();
  return {
    retired,
    negativesSettled,
    reopened: reopened.length,
    more:
      retired >= limit || negativesSettled >= limit || reopened.length >= limit,
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
    .update(imageProcessingJob)
    .set({ runAt: new Date(), waitReason: null })
    .where(
      and(
        eq(imageProcessingJob.imageId, imageId),
        eq(imageProcessingJob.state, "pending"),
        eq(imageProcessingJob.waitReason, "device"),
        isNull(imageProcessingJob.leaseUntil),
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
  /**
   * Which stored-object check failed, with the device claim beside the bytes
   * actually stored. The failed outcome replaces the claim on the job result.
   */
  outputCheck?: {
    failed: string[];
    claimed: {
      contentType: "image/png";
      sha256: string;
      width: number;
      height: number;
    };
    stored: {
      contentType: string | null;
      detectedContentType: string;
      sha256: string;
      width: number | null;
      height: number | null;
      transparency: boolean;
    };
  };
};

type CompletionJob = {
  id: ImageJobId;
  imageId: ImageId;
  derivativeId: string | null;
  kind: ImageProcessingJobKind;
  state: ImageProcessingJobState;
  attemptId: string | null;
  leaseValid: boolean;
  failures: number;
  lane: string;
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

/** Consecutive failures before retryable work stops for explicit retry (docs/jobs.md#retries). */
// With 30 s doubling backoff the twelfth failure lands about a day and a half in.
const IMAGE_PROCESSING_MAX_FAILURES = 12;

/**
 * Transient failures back off, up to `IMAGE_PROCESSING_MAX_FAILURES`. A
 * deterministic refusal, or work that kept failing, retains its evidence for
 * explicit retry rather than repeating the same operation.
 */
async function settleImageProcessingFailure(
  tx: DrizzleTransaction,
  job: CompletionJob,
  submitted: {
    reason: string;
    retryable: boolean;
    set: Partial<typeof imageProcessingJob.$inferInsert>;
  },
): Promise<void> {
  const failures = job.failures + 1;
  const input = {
    ...submitted,
    retryable: submitted.retryable && failures < IMAGE_PROCESSING_MAX_FAILURES,
  };
  const runAt = new Date(Date.now() + imageRetryDelayMs(failures));
  // The backoff ends while devices may idle; the ring covers it.
  if (input.retryable && job.lane === "device")
    await ringDeviceWorkAt(tx, runAt);
  await tx
    .update(imageProcessingJob)
    .set({
      ...input.set,
      state: input.retryable ? "pending" : "failed",
      completedAt: input.retryable ? null : new Date(),
      failures,
      runAt,
      leaseUntil: null,
      waitReason: null,
      lastError: input.reason,
    })
    .where(eq(imageProcessingJob.id, job.id));
  // A terminal Job must not leave its cutout pending or overwrite a usable output.
  if (!input.retryable && job.derivativeId)
    await tx
      .update(imageDerivative)
      .set({ status: "failed", failureReason: input.reason })
      .where(
        and(
          eq(imageDerivative.id, job.derivativeId),
          eq(imageDerivative.sourceContentHash, job.sourceContentHash),
          eq(imageDerivative.processorRevision, job.processorRevision),
          ne(imageDerivative.status, "ready"),
        ),
      );
}

async function adoptFailedCompletion(
  tx: DrizzleTransaction,
  job: CompletionJob,
  input: CompletionInput,
): Promise<boolean> {
  const outcome = input.result.outcome;
  if (outcome.status !== "failed") return false;
  // The failed attempt keeps its id on the row so the retry can prefer
  // another device; its lease is gone, so it can no longer adopt.
  await settleImageProcessingFailure(tx, job, {
    reason: outcome.reason,
    retryable: outcome.retryable,
    set: { runtime: input.runtime ?? null, result: outcome },
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
 * A negative subject-lift result settles these exact source/processor inputs.
 * Other executor skips retain a deterministic failure for explicit retry.
 */
function reportedSkipAsFailure(input: CompletionInput): CompletionInput {
  const outcome = input.result.outcome;
  if (outcome.status !== "skipped") return input;
  if (
    outcome.kind === "subject_lift" &&
    negativeSubjectLiftReasons.some((reason) => outcome.reason === reason)
  )
    return input;
  const failed = {
    status: "failed" as const,
    retryable: false,
    reason: outcome.reason,
  };
  return {
    ...input,
    result: { ...input.result, outcome: { ...failed, kind: outcome.kind } },
  };
}

async function adoptNegativeSubjectLiftCompletion(
  tx: DrizzleTransaction,
  job: CompletionJob,
  input: CompletionInput,
): Promise<boolean> {
  const outcome = input.result.outcome;
  if (
    outcome.kind !== "subject_lift" ||
    outcome.status !== "skipped" ||
    !negativeSubjectLiftReasons.some((reason) => outcome.reason === reason)
  )
    return false;
  if (job.derivativeId)
    await tx
      .update(imageDerivative)
      .set({
        status: "skipped",
        failureReason: outcome.reason,
      })
      .where(
        and(
          eq(imageDerivative.id, job.derivativeId),
          eq(imageDerivative.sourceContentHash, job.sourceContentHash),
          ne(imageDerivative.status, "ready"),
        ),
      );
  await tx
    .update(imageProcessingJob)
    .set({
      attemptId: null,
      runtime: input.runtime ?? null,
      result: outcome,
      state: "skipped",
      completedAt: sql`now()`,
      leaseUntil: null,
      failures: 0,
      lastError: null,
    })
    .where(eq(imageProcessingJob.id, job.id));
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
      leaseUntil: null,
      failures: 0,
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
    // has claimed the row (its attemptId is unchanged).
    const [job] = await tx
      .select({
        id: imageProcessingJob.id,
        runId: imageProcessingJob.runId,
        imageId: sql<ImageId>`${imageProcessingJob.imageId}`,
        derivativeId: imageProcessingJob.derivativeId,
        kind: imageProcessingJob.kind,
        state: imageProcessingJob.state,
        attemptId: imageProcessingJob.attemptId,
        leaseValid: sql<boolean>`${imageProcessingJob.leaseUntil} IS NOT NULL`,
        failures: imageProcessingJob.failures,
        lane: imageProcessingJob.lane,
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
        and(eq(imageDerivative.id, imageProcessingJob.derivativeId)),
      )
      .where(eq(imageProcessingJob.id, input.result.jobId))
      .for("update", { of: [imageProcessingJob, image] });
    if (!canAdoptCompletion(job, input)) {
      const attempt = await tx.query.imageProcessingAttempt.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              and(
                eq(imageProcessingAttempt.id, input.result.attemptId),
                eq(imageProcessingAttempt.jobId, input.result.jobId),
              ),
            ),
        },
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
      (await adoptFailedCompletion(tx, job, input)) ||
      (await adoptNegativeSubjectLiftCompletion(tx, job, input)) ||
      (await adoptSuccessfulCompletion(tx, job, input));
    if (!adopted) return { adopted: false, orphanKey: null };
    const outcome = input.result.outcome;
    const recorded = await tx
      .update(imageProcessingAttempt)
      .set({
        state: outcome.status === "completed" ? "ready" : outcome.status,
        completedAt: sql`now()`,
        result: outcome,
        diagnostics: sql`coalesce(${imageProcessingAttempt.diagnostics}, '{}'::jsonb) || ${JSON.stringify({ runtime: input.runtime ?? null, device: input.result.diagnostics ?? null, validation: input.verifiedDerivative ? { outcome: "validated transparent PNG", ...input.verifiedDerivative } : input.outputCheck ? { outcome: "rejected output", ...input.outputCheck } : input.orphanOutputKey ? { outcome: "rejected output" } : null })}::jsonb`,
        error: outcome.status === "completed" ? null : outcome.reason,
      })
      .where(eq(imageProcessingAttempt.id, input.result.attemptId))
      .returning({ id: imageProcessingAttempt.id });
    // A verdict before an executor record exists still retains its fenced attempt evidence.
    if (
      !recorded.length &&
      (outcome.status === "failed" || outcome.status === "skipped")
    )
      await insertImageProcessingAttempt(tx, {
        jobId: job.id,
        attemptId: input.result.attemptId,
        state: outcome.status,
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
    await recordChange(tx, {
      kind: "projection",
      categories: ["image", "imageJob", "relatedData"],
      ringFromBackground: true,
      changes: await imageProcessingRecordChanges(tx, [job.id], [job.imageId]),
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
  await recordChange(db, {
    kind: "projection",
    categories: ["image"],
    ringFromBackground: true,
    changes: await imageProcessingRecordChanges(db, [], [input.imageId]),
  });
}

/**
 * One resolver for image renderers. It never fetches, queues, or charges: a
 * transparent URL is usable only after the child row reached ready status for
 * the original's current content hash.
 */
export async function loadImageRepresentations(
  db: Database | DrizzleTransaction,
  shortcodes: ImageReadScope,
): Promise<Map<string, ImageRepresentations>> {
  if (imageScopeEmpty(shortcodes)) return new Map();
  const result = await unwrapDb(db).execute(
    imageRepresentationRowsSql(shortcodes, compatibleSubjectLiftOutputs),
    "objects",
  );
  return imageRepresentationsFromRows(
    z.array(imageRepresentationRow).parse(result),
  );
}

export async function getImageProcessingReadProjection(
  db: Database,
  imageId: ImageId,
) {
  const source = await getDb(db).query.image.findFirst({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(table, and(eq(image.id, imageId), notDeleted(image))),
    },
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
  input: {
    jobId: ImageJobId;
    attemptId: string;
    deviceId: DeviceId;
    userId: string;
  },
) {
  const [assignment] = await tx
    .select({
      state: imageProcessingJob.state,
      attemptId: imageProcessingJob.attemptId,
      leaseUntil: imageProcessingJob.leaseUntil,
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
    ? { status: "assigned" as const, leased: assignment.leaseUntil !== null }
    : { status: "lost" as const };
}

/**
 * A device stopped before finishing. Release is never an attempt: the job is
 * due again at once, and its next claim prefers another device. A release
 * after lease expiry still counts while no newer attempt replaced it.
 */
export async function releaseAssignedImageProcessingJob(
  db: Database,
  input: {
    jobId: ImageJobId;
    attemptId: string;
    deviceId: DeviceId;
    userId: string;
  },
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
 * A device heartbeat: extend the attempt's lease by 60 s while it still
 * owns the job. An expired lease no newer attempt replaced is renewed too,
 * matching late completion adoption. The command deadline is this lease.
 */
export async function renewAssignedImageProcessingLease(
  db: Database,
  input: {
    jobId: ImageJobId;
    attemptId: string;
    deviceId: DeviceId;
    userId: string;
  },
): Promise<
  | { ok: true; leaseExpiresAt: string }
  | { ok: false; reason: "lease_lost" | "job_obsolete" }
> {
  return withTransaction(db, async (tx) => {
    const assigned = await deviceAssignment(tx, input);
    if (assigned.status === "obsolete")
      return { ok: false as const, reason: "job_obsolete" as const };
    if (assigned.status !== "assigned" || !assigned.leased)
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
    const leaseUntil = new Date(Date.now() + DEVICE_LEASE_RENEWAL_MS);
    await tx
      .update(imageProcessingJob)
      .set({ leaseUntil })
      .where(eq(imageProcessingJob.id, input.jobId));
    return { ok: true as const, leaseExpiresAt: leaseUntil.toISOString() };
  });
}
