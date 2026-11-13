import type { ImageJobId } from "@cubby/schemas/identifiers";
import { IMAGE_IDENTIFICATION_MODEL } from "@cubby/schemas/image-identification";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
  imageProcessingCommand,
} from "@cubby/schemas/image-processing";
import type { ImageProcessingCommand } from "@cubby/schemas/image-processing";
import { jobWaitReason } from "@cubby/schemas/job";
import { providerFor } from "@cubby/shared/ai/models";

import { findErrorCause } from "~/lib/error-diagnostics";
import type { UnparsedError } from "~/lib/error-utils";
import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/policy/features";
import {
  generatePresignedDownloadUrl,
  generatePresignedUploadUrl,
  imageAnalysisKey,
} from "~/server/clients/s3";
import type { Database } from "~/server/db";
import {
  assertImageLeaseHeld,
  claimImageProcessingJob,
  completeImageProcessingJob,
} from "~/server/domains/image-processing/repo/image-processing";
import {
  assignImageProcessingExecutor,
  deferImageProcessingJob,
} from "~/server/domains/image-processing/repo/image-processing-history";
import { IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION } from "~/server/domains/image-processing/repo/processor-policy";
import { getVerifiedImageRendition } from "~/server/domains/image/repo/image-identification";
import { reserveImageAnalysisInput } from "~/server/generic/activity/repo/activity-input";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { withJobFence } from "~/server/workflows/runs/execution";

import { completeCloudImageDescription } from "./cloud-description";
import { completeCloudImageIdentification } from "./cloud-identification";
import { cloudFailureRetryable, safeImageProcessingError } from "./safe-error";

export type CloudImageDispatchOptions = {
  /** External storage/provider boundary; adoption still uses the real job ledger. */
  describe?: Parameters<typeof completeCloudImageDescription>[2];
  /** Reclaim only this lapsed attempt (a lease recovery). */
  attemptId?: string;
  /** Runs once the row's lease is held, before any provider work. */
  onClaimed?: (claim: {
    id: ImageJobId;
    attemptId: string;
    leaseExpiresAt: Date;
  }) => Promise<void>;
};

/**
 * A cloud attempt holds its row longer than one consumer can live (15 minutes), so
 * an expired lease means its invocation is gone. Nothing renews it. A crashed page
 * waits this long to retry, and the attempt fence protects a late publication.
 */
const CLOUD_IMAGE_LEASE_MS = 16 * 60_000;

/**
 * An AVIF identification waits this long for a device to prepare its rendition.
 * `bringImageProcessingForward` already sets `runAt` to now when that rendition
 * is stored, so the wait does not have to poll inside the suspend gap.
 */
const RENDITION_WAIT_MS = 60 * 60_000;

const cloudExecutor = (name: string) => ({
  kind: "cloud" as const,
  deviceId: null,
  name,
  platform: "cloud" as const,
  appVersion: null,
  osVersion: null,
});

/**
 * Run one cloud-lane row. Device work never reaches here: it is parked for
 * device pulls. A typed wait releases the lease without a failure; any other
 * failure is retried with backoff.
 */
export async function dispatchImageProcessingWakeup(
  db: Database,
  jobId: ImageJobId,
  options: CloudImageDispatchOptions = {},
): Promise<"completed" | "deferred" | "failed" | "skipped"> {
  const claimed = await claimImageProcessingJob(db, {
    jobId,
    kinds: ["identify_image", "describe_image"],
    leaseMs: CLOUD_IMAGE_LEASE_MS,
    ...(options.attemptId && { attemptId: options.attemptId }),
  });
  if (!claimed) return "skipped";
  await options.onClaimed?.(claimed);
  // Stops the next paid request, and any fenced publication, once the row is lost.
  const fence = {
    check: () => assertImageLeaseHeld(db, claimed),
    fence: (client: Database) => assertImageLeaseHeld(client, claimed),
  };
  return withJobFence(fence, async () => {
    try {
      if (claimed.kind === "identify_image") {
        if (
          claimed.originalContentType === "image/avif" &&
          !(await getVerifiedImageRendition(db, claimed.imageId))
        ) {
          await deferImageProcessingJob(db, {
            jobId: claimed.id,
            attemptId: claimed.attemptId,
            until: new Date(Date.now() + RENDITION_WAIT_MS),
            reason: "Waiting for an Apple device to prepare a JPEG rendition",
            waitReason: jobWaitReason.enum.device,
          });
          return "deferred";
        }
        const assigned = await assignImageProcessingExecutor(db, {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
          executor: cloudExecutor(providerFor(IMAGE_IDENTIFICATION_MODEL)),
        });
        if (!assigned) return "skipped";
        return (await completeCloudImageIdentification(db, {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
          imageId: claimed.imageId,
          runId: claimed.runId,
        }))
          ? "completed"
          : "skipped";
      }
      const assigned = await assignImageProcessingExecutor(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        executor: cloudExecutor(providerFor(IMAGE_DESCRIPTION_FEATURE.model)),
      });
      if (!assigned) return "skipped";
      return (await completeCloudImageDescription(
        db,
        {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
          imageId: claimed.imageId,
          runId: claimed.runId,
        },
        options.describe,
      ))
        ? "completed"
        : "skipped";
    } catch (error) {
      if (
        await deferCloudAttemptForTypedWait(
          db,
          { jobId: claimed.id, attemptId: claimed.attemptId },
          error,
        )
      )
        return "deferred";
      await completeImageProcessingJob(db, {
        result: {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
          completedAt: new Date().toISOString(),
          outcome: {
            kind: claimed.kind,
            status: "failed",
            retryable: cloudFailureRetryable(error),
            reason: safeImageProcessingError(error),
          },
        },
      });
      // The cause is on the row and it backs off; the next claim retries.
      return "failed";
    }
  });
}

/**
 * A typed wait (`JobDeferredError`: a provider or funding wait) is a wait,
 * never an attempt: the claim is released until the wait ends. Returns
 * whether `error` was such a wait. Every cloud provider call shares this,
 * including the description of a device-normalized AVIF.
 */
export async function deferCloudAttemptForTypedWait(
  db: Database,
  attempt: { jobId: ImageJobId; attemptId: string },
  error: UnparsedError,
): Promise<boolean> {
  const deferred = findErrorCause(
    error,
    (cause): cause is JobDeferredError => cause instanceof JobDeferredError,
  );
  if (deferred) {
    await deferImageProcessingJob(db, {
      ...attempt,
      until: deferred.until,
      reason: deferred.message,
      waitReason: deferred.reason,
    });
    return true;
  }
  return false;
}

/** Both transports mint exactly the same source/output capabilities. */
export async function prepareCompanionImageCommand(
  claimed: NonNullable<Awaited<ReturnType<typeof claimImageProcessingJob>>>,
) {
  if (claimed.kind === "identify_image")
    throw new Error("Image identification is server-only");
  if (claimed.kind === "describe_image") {
    const analysisKey =
      claimed.originalContentType === "image/avif" &&
      claimed.processorRevision !== IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION
        ? imageAnalysisKey("staging", claimed.attemptId)
        : null;
    const [sourceUrl, uploadUrl] = await Promise.all([
      generatePresignedDownloadUrl({ key: claimed.originalKey }),
      analysisKey
        ? generatePresignedUploadUrl({
            key: analysisKey,
            contentType: "image/jpeg",
          })
        : null,
    ]);
    return imageProcessingCommand.parse({
      kind: "describe_image",
      jobId: claimed.id,
      attemptId: claimed.attemptId,
      deadline: claimed.leaseExpiresAt.toISOString(),
      source: {
        url: sourceUrl,
        sha256: claimed.sourceContentHash,
        contentType: claimed.originalContentType,
      },
      promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
      resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
      ...(analysisKey && uploadUrl
        ? {
            analysisOutput: {
              key: analysisKey,
              contentType: "image/jpeg",
              uploadUrl,
            },
          }
        : {}),
    });
  }
  // The claim rebuilds a missing derivative and mints a fresh output key.
  if (!claimed.derivativeKey)
    throw new Error("Subject-lift lease has no output key");
  const [sourceUrl, uploadUrl] = await Promise.all([
    generatePresignedDownloadUrl({ key: claimed.originalKey }),
    generatePresignedUploadUrl({
      key: claimed.derivativeKey,
      contentType: "image/png",
    }),
  ]);
  return imageProcessingCommand.parse({
    kind: "subject_lift",
    jobId: claimed.id,
    attemptId: claimed.attemptId,
    deadline: claimed.leaseExpiresAt.toISOString(),
    source: {
      url: sourceUrl,
      sha256: claimed.sourceContentHash,
      contentType: claimed.originalContentType,
    },
    output: { key: claimed.derivativeKey, uploadUrl, contentType: "image/png" },
  });
}

/** Reserve only after assignment creates the attempt, before either transport delivers its PUT. */
export async function reserveCompanionAnalysisOutput(
  db: Database,
  command: ImageProcessingCommand,
) {
  return (
    command.kind !== "describe_image" ||
    !command.analysisOutput ||
    (await reserveImageAnalysisInput(
      db,
      command.attemptId,
      command.analysisOutput.key,
    ))
  );
}
