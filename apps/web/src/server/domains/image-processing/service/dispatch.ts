import { IMAGE_IDENTIFICATION_MODEL } from "@cubby/schemas/image-identification";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
  imageProcessingCommand,
} from "@cubby/schemas/image-processing";
import type { ImageProcessingCommand } from "@cubby/schemas/image-processing";
import { jobWaitReason } from "@cubby/schemas/job";
import { providerFor } from "@cubby/shared/ai/models";
import { z } from "zod";

import { findErrorCause } from "~/lib/error-diagnostics";
import { AiBudgetExhaustedError } from "~/server/ai/budget";
import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/policy/features";
import {
  generatePresignedDownloadUrl,
  generatePresignedUploadUrl,
  imageAnalysisKey,
} from "~/server/clients/s3";
import type { Database } from "~/server/db";
import {
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  claimImageProcessingJob,
  completeImageProcessingJob,
  SERVER_FAILURE_RETRYABLE,
} from "~/server/domains/image-processing/repo/image-processing";
import {
  assignImageProcessingExecutor,
  deferImageProcessingJob,
} from "~/server/domains/image-processing/repo/image-processing-history";
import { getVerifiedImageRenditionKey } from "~/server/domains/image/repo/image-identification";
import { reserveImageAnalysisInput } from "~/server/generic/activity/repo/activity-input";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";

import { completeCloudImageDescription } from "./cloud-description";
import { completeCloudImageIdentification } from "./cloud-identification";
import { COMPANION_LEASE_MS } from "./contracts";
import { safeImageProcessingError } from "./safe-error";

export type CloudImageDispatchOptions = {
  /** External storage/provider boundary; adoption still uses the real job ledger. */
  describe?: Parameters<typeof completeCloudImageDescription>[2];
};

/** An AVIF identification waits this long for a device to prepare its rendition. */
const RENDITION_WAIT_MS = 10 * 60_000;

const cloudExecutor = (name: string) => ({
  kind: "cloud" as const,
  deviceId: null,
  name,
  platform: "cloud" as const,
  appVersion: null,
  osVersion: null,
});

/**
 * Run one cloud-lane row under the drain's `image.cloud` claim. Device work
 * never reaches here: it is parked for device pulls. A typed wait releases
 * the claim without an attempt; any other failure is retried with backoff.
 */
export async function dispatchImageProcessingWakeup(
  db: Database,
  jobId: string,
  options: CloudImageDispatchOptions = {},
): Promise<"completed" | "deferred" | "failed" | "skipped"> {
  const claimed = await claimImageProcessingJob(db, {
    jobId,
    kinds: ["identify_image", "describe_image"],
    leaseMs: COMPANION_LEASE_MS,
  });
  if (!claimed) return "skipped";
  try {
    if (claimed.kind === "identify_image") {
      if (
        claimed.originalContentType === "image/avif" &&
        !(await getVerifiedImageRenditionKey(db, claimed.imageId))
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
    const deferred = findErrorCause(
      error,
      (cause): cause is JobDeferredError => cause instanceof JobDeferredError,
    );
    if (deferred) {
      await deferImageProcessingJob(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        until: deferred.until,
        reason: deferred.message,
        waitReason: deferred.reason,
      });
      return "deferred";
    }
    // Running out of AI money is a funding wait, never an attempt.
    if (error instanceof AiBudgetExhaustedError) {
      await deferImageProcessingJob(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        until: new Date(error.resumeAt),
        reason: error.message,
        waitReason: jobWaitReason.enum.ai_funding_window,
      });
      return "deferred";
    }
    await completeImageProcessingJob(db, {
      result: {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: claimed.kind,
          status: "failed",
          retryable: SERVER_FAILURE_RETRYABLE,
          reason: safeImageProcessingError(error),
        },
      },
    });
    // The cause is on the row and its Job backs off; the next claim retries.
    return "failed";
  }
}

/** Both transports mint exactly the same source/output capabilities. */
export async function prepareCompanionImageCommand(
  claimed: NonNullable<Awaited<ReturnType<typeof claimImageProcessingJob>>>,
) {
  if (claimed.kind === "identify_image")
    throw new Error("Image identification is server-only");
  if (claimed.kind === "describe_image") {
    const command = imageProcessingCommand.parse({
      kind: "describe_image",
      jobId: claimed.id,
      attemptId: claimed.attemptId,
      deadline: claimed.leaseExpiresAt.toISOString(),
      source: {
        url: await generatePresignedDownloadUrl({ key: claimed.originalKey }),
        sha256: claimed.sourceContentHash,
        contentType: claimed.originalContentType,
      },
      promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
      resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
    });
    if (command.kind !== "describe_image")
      throw new Error("Expected description command");
    if (
      claimed.originalContentType === "image/avif" &&
      claimed.processorRevision !== IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION
    ) {
      const key = imageAnalysisKey("staging", claimed.attemptId);
      command.analysisOutput = {
        key,
        contentType: "image/jpeg",
        uploadUrl: await generatePresignedUploadUrl({
          key,
          contentType: "image/jpeg",
        }),
      };
    }
    return command;
  }
  // The claim rebuilds a missing derivative and mints a fresh output key.
  if (!claimed.derivativeKey)
    throw new Error("Subject-lift lease has no output key");
  return imageProcessingCommand.parse({
    kind: "subject_lift",
    jobId: claimed.id,
    attemptId: claimed.attemptId,
    deadline: claimed.leaseExpiresAt.toISOString(),
    source: {
      url: await generatePresignedDownloadUrl({ key: claimed.originalKey }),
      sha256: claimed.sourceContentHash,
      contentType: claimed.originalContentType,
    },
    output: {
      key: claimed.derivativeKey,
      uploadUrl: await generatePresignedUploadUrl({
        key: claimed.derivativeKey,
        contentType: "image/png",
      }),
      contentType: "image/png",
    },
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

/** The server drain's `image.cloud` handler; device work is claimed by device pulls. */
export const imageProcessingJobHandler = defineJobHandler(
  z.object({ processingId: z.uuid() }),
  async (db, _claim, input) => {
    const outcome = await dispatchImageProcessingWakeup(db, input.processingId);
    return { page: { done: true, result: { outcome } } };
  },
);
