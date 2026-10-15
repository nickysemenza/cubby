import { IMAGE_IDENTIFICATION_MODEL } from "@cubby/schemas/image-identification";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
  imageProcessingCommand,
} from "@cubby/schemas/image-processing";
import type { ImageProcessingCommand } from "@cubby/schemas/image-processing";
import { providerFor } from "@cubby/shared/ai/models";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { getImageProcessingNamespace } from "~/server/cf-env";
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
  markImageProcessingWaitingForDevice,
  reclaimExpiredImageProcessingLeases,
} from "~/server/domains/image-processing/repo/image-processing";
import { assignImageProcessingExecutor } from "~/server/domains/image-processing/repo/image-processing-history";
import { readImageProcessingSettings } from "~/server/domains/image-processing/repo/image-processing-maintenance";
import { getVerifiedImageRenditionKey } from "~/server/domains/image/repo/image-identification";
import { reserveImageAnalysisInput } from "~/server/generic/activity/repo/activity-input";

import { completeCloudImageDescription } from "./cloud-description";
import { completeCloudImageIdentification } from "./cloud-identification";
import {
  COMPANION_LEASE_MS,
  type ImageProcessingCompanionRpc,
} from "./contracts";
import { safeImageProcessingError } from "./safe-error";

export type CloudImageDispatchOptions = {
  /** External storage/provider boundary; adoption still uses the real job ledger. */
  describe?: Parameters<typeof completeCloudImageDescription>[2];
};

type ImageProcessingStub = ReturnType<
  NonNullable<ReturnType<typeof getImageProcessingNamespace>>["getByName"]
>;

function companionRpc(value: ImageProcessingStub): ImageProcessingCompanionRpc {
  // SAFETY: this binding names ImageProcessingDurableObject, whose public RPC
  // surface implements ImageProcessingCompanionRpc.
  return value as ImageProcessingCompanionRpc;
}

/** Dispatch one durable row. A missing device changes state to waiting; it never blocks a request or queue lease. */
export async function dispatchImageProcessingWakeup(
  db: Database,
  jobId: string,
  options: CloudImageDispatchOptions = {},
): Promise<"dispatched" | "completed" | "waiting" | "skipped"> {
  const settings = await readImageProcessingSettings(db);
  if (settings.paused) return "skipped";
  await reclaimExpiredImageProcessingLeases(db);
  const claimed = await claimImageProcessingJob(db, {
    jobId,
    kinds: ["identify_image", "describe_image", "subject_lift"],
    leaseMs: COMPANION_LEASE_MS,
  });
  if (!claimed) return "skipped";
  try {
    if (claimed.kind === "identify_image") {
      if (
        claimed.originalContentType === "image/avif" &&
        !(await getVerifiedImageRenditionKey(db, claimed.imageId))
      ) {
        await markImageProcessingWaitingForDevice(db, {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
        });
        return "waiting";
      }
      const assigned = await assignImageProcessingExecutor(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        executor: {
          kind: "cloud",
          deviceId: null,
          name: providerFor(IMAGE_IDENTIFICATION_MODEL),
          platform: "cloud",
          appVersion: null,
          osVersion: null,
        },
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
    if (
      claimed.kind === "describe_image" &&
      claimed.processorRevision !==
        IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION &&
      claimed.originalContentType !== "image/avif"
    ) {
      const assigned = await assignImageProcessingExecutor(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        executor: {
          kind: "cloud",
          deviceId: null,
          name: providerFor(IMAGE_DESCRIPTION_FEATURE.model),
          platform: "cloud",
          appVersion: null,
          osVersion: null,
        },
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
    }

    const namespace = getImageProcessingNamespace();
    if (!namespace) {
      await markImageProcessingWaitingForDevice(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
      });
      return "waiting";
    }
    const command = await prepareCompanionImageCommand(db, claimed);
    if (!command) return "skipped";
    const dispatched = await companionRpc(
      namespace.getByName("household"),
    ).dispatch(command);
    if (!dispatched) {
      await markImageProcessingWaitingForDevice(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
      });
      return "waiting";
    }
    return "dispatched";
  } catch (error) {
    const detail = safeImageProcessingError(error);
    await completeImageProcessingJob(db, {
      result: {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: claimed.kind,
          status: "failed",
          retryable: claimed.attempts < 3,
          reason: detail,
        },
      },
    });
    // The database row is visible to Problems and periodic repair republishes
    // it; never leave a leased row hidden after a provider/storage failure.
    return "waiting";
  }
}

/** Both transports mint exactly the same source/output capabilities. */
export async function prepareCompanionImageCommand(
  db: Database,
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
  if (!claimed.derivativeKey) {
    await markImageProcessingWaitingForDevice(db, {
      jobId: claimed.id,
      attemptId: claimed.attemptId,
    });
    return null;
  }
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
