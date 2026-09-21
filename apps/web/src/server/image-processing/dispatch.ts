import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
  imageProcessingCommand,
} from "@cubby/schemas/image-processing";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import { getImageProcessingNamespace } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  claimImageProcessingJob,
  completeImageProcessingJob,
  findImageProcessingWakeupsForImage,
  getCurrentImageCutoutEligibility,
  markImageProcessingWaitingForDevice,
  reclaimExpiredImageProcessingLeases,
} from "~/server/repo/image-processing";
import { assignImageProcessingExecutor } from "~/server/repo/image-processing-history";
import { readImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import { refreshDirectImageOwnerSearchDocuments } from "~/server/repo/search-document";
import { describeOriginalImage } from "~/server/services/image-description.service";
import {
  generatePresignedDownloadUrl,
  generatePresignedUploadUrl,
} from "~/server/utils/s3";

import type { ImageProcessingCompanionRpc } from "./contracts";
import { safeImageProcessingError } from "./safe-error";

const LEASE_MS = 5 * 60_000;
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
): Promise<"dispatched" | "completed" | "waiting" | "skipped"> {
  const settings = await readImageProcessingSettings(db);
  if (settings.paused) return "skipped";
  await reclaimExpiredImageProcessingLeases(db);
  const claimed = await claimImageProcessingJob(db, {
    jobId,
    kinds: ["describe_image", "subject_lift"],
    leaseMs: LEASE_MS,
  });
  if (!claimed) return "skipped";
  try {
    if (
      claimed.kind === "describe_image" &&
      claimed.processorRevision !== IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION
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
      const { result, fingerprint } = await describeOriginalImage(db, {
        imageId: claimed.imageId,
        attemptId: claimed.attemptId,
      });
      const completion = await completeImageProcessingJob(db, {
        result: {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
          completedAt: new Date().toISOString(),
          outcome: {
            kind: "describe_image",
            status: "completed",
            description: result,
            runtime: {
              platform: "cloud",
              model: IMAGE_DESCRIPTION_FEATURE.model,
            },
          },
        },
        cloudAnalysis: {
          provider: providerFor(IMAGE_DESCRIPTION_FEATURE.model),
          model: IMAGE_DESCRIPTION_FEATURE.model,
          promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
          resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
          inputFingerprint: fingerprint,
        },
        runtime: {
          provider: providerFor(IMAGE_DESCRIPTION_FEATURE.model),
          model: IMAGE_DESCRIPTION_FEATURE.model,
          feature: "image-description",
        },
      });
      if (!completion.adopted) return "skipped";
      await refreshDirectImageOwnerSearchDocuments(db, claimed.imageId);
      const { publishImageProcessingWakeups } =
        await import("~/server/services/image-processing.service");
      await publishImageProcessingWakeups(
        db,
        await findImageProcessingWakeupsForImage(db, claimed.imageId),
      );
      return "completed";
    }

    if (claimed.kind === "describe_image") {
      const namespace = getImageProcessingNamespace();
      if (!namespace) {
        await markImageProcessingWaitingForDevice(db, {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
        });
        return "waiting";
      }
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
    }

    const eligibility = await getCurrentImageCutoutEligibility(
      db,
      claimed.imageId,
      claimed.sourceContentHash,
    );
    if (eligibility === null) {
      await markImageProcessingWaitingForDevice(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
      });
      return "waiting";
    }
    if (eligibility !== "eligible") {
      await completeImageProcessingJob(db, {
        result: {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
          completedAt: new Date().toISOString(),
          outcome: {
            kind: "subject_lift",
            status: "skipped",
            reason: "not_suitable",
          },
        },
      });
      return "skipped";
    }

    const namespace = getImageProcessingNamespace();
    if (!namespace || !claimed.derivativeKey) {
      await markImageProcessingWaitingForDevice(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
      });
      return "waiting";
    }
    const command = imageProcessingCommand.parse({
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
