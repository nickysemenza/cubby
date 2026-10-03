import { parseShortcodeFor, type RunId } from "@cubby/schemas/identifiers";
import {
  pullCompanionImageProcessingInput,
  imageProcessingTerminalResult,
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import type {
  ImageProcessingJobKind,
  ImageProcessingTerminalResult as ImageProcessingResult,
  ImageProcessingResult as CompanionImageProcessingResult,
} from "@cubby/schemas/image-processing";
import {
  readResponseWithLimit,
  MAX_EXTERNAL_IMAGE_BYTES,
} from "@cubby/shared/external-fetch";
import { z } from "zod";

import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import { completeCloudImageDescription } from "~/server/image-processing/cloud-description";
import {
  prepareCompanionImageCommand,
  reserveCompanionAnalysisOutput,
} from "~/server/image-processing/dispatch";
import { safeImageProcessingError } from "~/server/image-processing/safe-error";
import { reserveImageAnalysisInput } from "~/server/repo/activity-input";
import { upsertDeviceFromHello } from "~/server/repo/device-participation";
import {
  claimImageProcessingJob,
  reclaimExpiredImageProcessingLeases,
  markImageProcessingWaitingForDevice,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
} from "~/server/repo/image-processing";
import { retryFailedImageProcessingJobs } from "~/server/repo/image-processing";
import {
  completeImageProcessingJob,
  getLeasedImageProcessingOutputKey,
  claimImageProcessingOrphans,
  finalizeImageProcessingOrphans,
  getLeasedImageProcessingJobContext,
} from "~/server/repo/image-processing";
import {
  assignImageProcessingExecutor,
  isAssignedImageProcessingDevice,
} from "~/server/repo/image-processing-history";
import {
  recordImageProcessingEvent,
  createImageProcessingSubmission,
} from "~/server/repo/image-processing-history";
import { readImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
import {
  persistImageProcessingSubmission,
  persistAppleImageDescriptionSubmission,
} from "~/server/repo/image-processing-submission";
import { refreshDirectImageOwnerSearchDocuments } from "~/server/repo/search-document";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { imageDescriptionInputFingerprint } from "~/server/services/image-description.service";
import { inspectImageFile } from "~/server/services/image-integrity";
import { hasMeaningfulPngTransparency } from "~/server/services/image-transparency";
import { deleteS3Object, getS3Object } from "~/server/utils/s3";

const IMAGE_PROCESSING_WAKEUP_SOURCE = "image-processing";

/**
 * Persist both jobs before publishing their lightweight wakeups. The caller
 * never waits for a companion: durable rows repair a missed publication.
 */
export async function scheduleImageProcessingJobs(
  db: Database,
  input: {
    id: string;
    kinds: readonly ImageProcessingJobKind[];
    publish?: boolean;
    automatic?: boolean;
    submission?: { id: string; publicId: string };
    /** The Run that requested this scheduling, when the caller has one. */
    runId?: RunId | null;
  },
): Promise<{ jobIds: string[]; submissionId?: string }> {
  const settings = await readImageProcessingSettings(db);
  if (input.automatic && !settings.enabled) return { jobIds: [] };
  const scheduled = await persistImageProcessingSubmission(db, input);
  if (input.publish !== false && !settings.paused)
    await publishImageProcessingWakeups(db, scheduled.jobIds);
  return scheduled;
}

/** Queue payloads only wake durable rows, so repeats and repairs are harmless. */
export async function publishImageProcessingWakeups(
  db: Database,
  jobIds: readonly string[],
): Promise<void> {
  const settings = await readImageProcessingSettings(db);
  if (settings.paused || jobIds.length === 0) return;
  await publishBackgroundTasks(
    db,
    [...new Set(jobIds)].map((jobId) => ({
      kind: "image-processing.wakeup" as const,
      requestedAt: new Date().toISOString(),
      jobId,
    })),
    { source: IMAGE_PROCESSING_WAKEUP_SOURCE },
  );
}

/** Remove only orphan outputs whose signed upload window has elapsed. */
export async function cleanupExpiredImageProcessingOrphans(
  db: Database,
  limit: number,
): Promise<number> {
  const keys = await claimImageProcessingOrphans(db, limit);
  await Promise.all(keys.map((key) => deleteS3Object(key)));
  await finalizeImageProcessingOrphans(db, keys);
  return keys.length;
}

/** Explicit, authorized sample evaluation; it never changes the cloud preference. */
export async function scheduleAppleImageDescriptionEvaluation(
  db: Database,
  input: { id: string },
): Promise<{ jobId: string | null }> {
  const scheduled = await persistAppleImageDescriptionSubmission(db, input);
  if (scheduled.jobId)
    await publishImageProcessingWakeups(db, [scheduled.jobId]);
  return scheduled;
}

async function verifyTransparentOutput(
  key: string,
  result: Extract<
    ImageProcessingResult["outcome"],
    { kind: "subject_lift"; status: "completed" }
  >,
) {
  const response = await getS3Object(key);
  if (!response.ok) throw new Error(`Transparent output ${key} is unavailable`);
  const storedType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const bytes = new Uint8Array(await response.arrayBuffer());
  const inspected = await inspectImageFile(bytes, "image/png");
  const hasTransparency = await hasMeaningfulPngTransparency(bytes);
  if (
    storedType !== "image/png" ||
    inspected.detectedContentType !== "image/png" ||
    inspected.sha256 !== result.sha256 ||
    inspected.width !== result.width ||
    inspected.height !== result.height ||
    !hasTransparency
  )
    throw new Error("Transparent output does not match the leased command");
  return {
    sha256: inspected.sha256,
    contentType: "image/png" as const,
    width: inspected.width,
    height: inspected.height,
  };
}

/**
 * Validate result bytes before adoption. The same current-attempt/source checks
 * run inside the repository transaction after this slow object read.
 */
export async function completeCompanionImageProcessingResult(
  db: Database,
  result: CompanionImageProcessingResult,
): Promise<{ adopted: boolean }> {
  if (result.outcome.status === "normalized")
    return completeNormalizedImageInput(db, result, result.outcome);
  const prepared = await prepareCompanionCompletion(
    db,
    imageProcessingTerminalResult.parse(result),
  );
  if (!prepared) {
    await recordImageProcessingEvent(db, {
      jobId: result.jobId,
      eventKey: `${result.attemptId}:rejected`,
      event: "completion.rejected",
      level: "debug",
      details: {
        reason:
          "Attempt or input is no longer current, or output validation failed",
      },
    });
    return { adopted: false };
  }
  const completion = await completeImageProcessingJob(db, prepared.input);
  if (completion.adopted && prepared.searchImageId)
    await refreshDirectImageOwnerSearchDocuments(db, prepared.searchImageId);
  return { adopted: completion.adopted };
}

async function readVerifiedAnalysisJPEG(
  key: string,
  outcome: Extract<
    CompanionImageProcessingResult["outcome"],
    { status: "normalized" }
  >,
) {
  const response = await getS3Object(key);
  if (!response.ok)
    throw new Error(
      `Analysis staging output is unavailable: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  const storedType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const bytes = await readResponseWithLimit(response, MAX_EXTERNAL_IMAGE_BYTES);
  const inspected = await inspectImageFile(bytes, "image/jpeg");
  if (
    storedType !== "image/jpeg" ||
    inspected.detectedContentType !== "image/jpeg" ||
    inspected.sha256 !== outcome.sha256 ||
    inspected.width !== outcome.width ||
    inspected.height !== outcome.height ||
    outcome.width > 2048 ||
    outcome.height > 2048
  )
    throw new Error(
      "Analysis JPEG does not match the leased normalization command",
    );
  return bytes;
}

async function completeNormalizedImageInput(
  db: Database,
  result: CompanionImageProcessingResult,
  outcome: Extract<
    CompanionImageProcessingResult["outcome"],
    { status: "normalized" }
  >,
): Promise<{ adopted: boolean }> {
  const context = await getLeasedImageProcessingJobContext(db, result);
  const stageKey = `cubby/analysis-staging/${result.attemptId}.jpg`;
  if (
    !context ||
    context.kind !== "describe_image" ||
    context.processorRevision !== IMAGE_DESCRIPTION_PROCESSOR_REVISION ||
    context.contentType !== "image/avif" ||
    context.inputKey !== stageKey ||
    outcome.key !== stageKey
  )
    return { adopted: false };
  const snapshotKey = `cubby/analysis-inputs/${result.attemptId}-${crypto.randomUUID()}.jpg`;
  if (
    !(await reserveImageAnalysisInput(
      db,
      result.attemptId,
      snapshotKey,
      stageKey,
    ))
  )
    return { adopted: false };
  try {
    const bytes = await readVerifiedAnalysisJPEG(stageKey, outcome);
    // Recheck after storage IO; the cloud helper snapshots these bytes under a server-only key.
    const current = await getLeasedImageProcessingJobContext(db, result);
    if (!current || current.inputKey !== snapshotKey) return { adopted: false };
    return {
      adopted: await completeCloudImageDescription(db, {
        jobId: result.jobId,
        attemptId: result.attemptId,
        imageId: context.imageId,
        runId: context.runId,
        normalizedInput: { bytes, key: snapshotKey },
      }),
    };
  } catch (error) {
    const completion = await completeImageProcessingJob(db, {
      result: {
        ...result,
        outcome: {
          kind: "describe_image",
          status: "failed",
          retryable: context.attempts < 3,
          reason: safeImageProcessingError(error),
        },
      },
    });
    return { adopted: completion.adopted };
  }
}

type VerifiedDerivative = {
  sha256: string;
  contentType: "image/png";
  width: number;
  height: number;
};

async function prepareCompanionCompletion(
  db: Database,
  result: ImageProcessingResult,
) {
  if (
    result.outcome.kind === "subject_lift" &&
    result.outcome.status === "completed"
  ) {
    const verifiedDerivative = await prepareSubjectLiftCompletion(
      db,
      result,
      result.outcome,
    );
    return verifiedDerivative
      ? {
          input: { result, verifiedDerivative },
          searchImageId: null,
        }
      : null;
  }
  if (
    result.outcome.kind === "describe_image" &&
    result.outcome.status === "completed"
  )
    return prepareAppleDescriptionCompletion(db, result, result.outcome);
  return {
    input: { result },
    searchImageId: null,
  };
}

async function prepareSubjectLiftCompletion(
  db: Database,
  result: ImageProcessingResult,
  outcome: Extract<
    ImageProcessingResult["outcome"],
    { kind: "subject_lift"; status: "completed" }
  >,
): Promise<VerifiedDerivative | null> {
  const outputKey = await getLeasedImageProcessingOutputKey(db, result);
  if (!outputKey) return null;
  try {
    return await verifyTransparentOutput(outputKey, outcome);
  } catch (error) {
    // The key belongs to this attempt. Failure and delayed cleanup commit as
    // one unit so invalid bytes cannot be stranded by a worker crash.
    const reason = safeImageProcessingError(error);
    await completeImageProcessingJob(db, {
      result: {
        ...result,
        outcome: {
          kind: "subject_lift",
          status: "failed",
          retryable: false,
          reason,
        },
      },
      orphanOutputKey: outputKey,
    });
    return null;
  }
}

async function prepareAppleDescriptionCompletion(
  db: Database,
  result: ImageProcessingResult,
  outcome: Extract<
    ImageProcessingResult["outcome"],
    { kind: "describe_image"; status: "completed" }
  >,
) {
  const context = await getLeasedImageProcessingJobContext(db, result);
  if (!context) return null;
  const model = outcome.runtime.model ?? "apple";
  const description = {
    ...outcome.description,
    claims: outcome.description.claims.map((claim) => ({
      ...claim,
      imageId: parseShortcodeFor("image", context.sourceShortcode),
    })),
  };
  const completionResult: ImageProcessingResult = {
    ...result,
    outcome: {
      kind: "describe_image",
      status: "completed",
      description,
      runtime: outcome.runtime,
    },
  };
  return {
    input: {
      result: completionResult,
      runtime: outcome.runtime,
      appleAnalysis: {
        provider: "apple",
        model,
        promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
        resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
        inputFingerprint: imageDescriptionInputFingerprint({
          sourceContentHash: context.sourceContentHash,
          contentType: context.contentType,
          provider: "apple",
          model,
          promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
          resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
        }),
      },
    },
    searchImageId: context.imageId,
  };
}

export async function retryImageProcessingFailures(
  db: Database,
  input: { id: string },
) {
  const imageId = await resolveOrThrow(db, "image", input.id);
  const submission = await createImageProcessingSubmission(db);
  const jobs = await retryFailedImageProcessingJobs(db, 100, {
    imageId,
    submissionId: submission.id,
  });
  await publishImageProcessingWakeups(db, jobs);
  return { retried: jobs.length, submissionId: submission.publicId };
}

/** Pulling grants one bounded assignment; the socket's foreground gate stays truthful. */
function companionClaimCapabilities(
  hello: z.infer<typeof pullCompanionImageProcessingInput>["hello"],
) {
  const revisions: number[] = [];
  const kinds: ImageProcessingJobKind[] = [];
  if (
    hello.capabilities.visionSubjectLift.available &&
    hello.capabilities.visionSubjectLift.revision === 1
  ) {
    kinds.push("subject_lift");
    revisions.push(IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION);
  }
  if (
    hello.capabilities.actualImageDescription.available &&
    hello.capabilities.actualImageDescription.revision === 1
  ) {
    kinds.push("describe_image");
    revisions.push(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
  }
  const allowAvifNormalization =
    hello.capabilities.jpegNormalization?.available === true &&
    hello.capabilities.jpegNormalization.revision === 1;
  if (allowAvifNormalization && !kinds.includes("describe_image"))
    kinds.push("describe_image");
  return { revisions, kinds, allowAvifNormalization };
}

export async function pullCompanionImageProcessing(
  db: Database,
  input: z.infer<typeof pullCompanionImageProcessingInput>,
  userId: string,
) {
  const hello = input.hello;
  const participation = await upsertDeviceFromHello(db, {
    installationId: hello.deviceId,
    name: hello.deviceName ?? "Apple device",
    platform: hello.platform,
    appVersion: hello.appVersion,
    osVersion: hello.osVersion ?? null,
    automaticWork: hello.participation.automaticWork,
  });
  const empty = { command: null, remotePaused: participation.remotePaused };
  if (
    !participation.automaticWork ||
    participation.remotePaused ||
    (await readImageProcessingSettings(db)).paused
  )
    return empty;
  const { revisions, kinds, allowAvifNormalization } =
    companionClaimCapabilities(hello);
  if (!kinds.length) return empty;
  await reclaimExpiredImageProcessingLeases(db);
  for (let skipped = 0; skipped < 8; skipped++) {
    const claimed = await claimImageProcessingJob(db, {
      kinds,
      processorRevisions: revisions,
      allowAvifNormalization,
      leaseMs: input.leaseSeconds * 1000,
    });
    if (!claimed) return empty;
    try {
      const command = await prepareCompanionImageCommand(db, claimed);
      if (!command) continue;
      const assigned = await assignImageProcessingExecutor(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        userId,
        executor: {
          kind: "device",
          deviceId: hello.deviceId,
          name: hello.deviceName ?? "Apple device",
          platform: hello.platform,
          appVersion: hello.appVersion,
          osVersion: hello.osVersion ?? null,
        },
      });
      if (!assigned) {
        await markImageProcessingWaitingForDevice(db, {
          jobId: claimed.id,
          attemptId: claimed.attemptId,
        });
        return empty;
      }
      if (!(await reserveCompanionAnalysisOutput(db, command))) return empty;
      return { command, remotePaused: false };
    } catch (error) {
      await markImageProcessingWaitingForDevice(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
      });
      throw error;
    }
  }
  return empty;
}

export async function completeAssignedCompanionImageProcessing(
  db: Database,
  input: { deviceId: string; result: CompanionImageProcessingResult },
  userId: string,
) {
  if (
    !(await isAssignedImageProcessingDevice(db, {
      jobId: input.result.jobId,
      attemptId: input.result.attemptId,
      deviceId: input.deviceId,
      userId,
    }))
  )
    return { adopted: false };
  return completeCompanionImageProcessingResult(db, input.result);
}
