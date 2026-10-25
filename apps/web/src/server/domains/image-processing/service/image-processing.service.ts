import {
  parseEntityId,
  parseShortcodeFor,
  type RunId,
} from "@cubby/schemas/identifiers";
import {
  imageProcessingHello,
  pullCompanionImageProcessingInput,
  imageProcessingTerminalResult,
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import type {
  ImageProcessingCommand,
  ImageProcessingJobKind,
  ImageProcessingTerminalResult as ImageProcessingResult,
  ImageProcessingResult as CompanionImageProcessingResult,
} from "@cubby/schemas/image-processing";
import { readResponseWithLimit } from "@cubby/shared/external-fetch";
import { z } from "zod";

import {
  deleteS3Object,
  getS3Object,
  imageAnalysisKey,
} from "~/server/clients/s3";
import type { Database } from "~/server/db";
import { upsertDeviceFromHello } from "~/server/domains/device/repo/device-participation";
import {
  claimImageProcessingJob,
  releaseImageProcessingLease,
  SERVER_FAILURE_RETRYABLE,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  retryImageProcessingNow,
  retryBackingOffDeviceWork,
  completeImageProcessingJob,
  getLeasedImageProcessingOutputKey,
  claimImageProcessingOrphans,
  finalizeImageProcessingOrphans,
  getLeasedImageProcessingJobContext,
} from "~/server/domains/image-processing/repo/image-processing";
import {
  assignImageProcessingExecutor,
  findImageProcessingDeviceAssignment,
  recordImageProcessingEvent,
  createImageProcessingSubmission,
} from "~/server/domains/image-processing/repo/image-processing-history";
import { publishImageProcessingWakeups } from "~/server/domains/image-processing/repo/image-processing-maintenance";
import {
  persistImageProcessingSubmission,
  persistAppleImageDescriptionSubmission,
} from "~/server/domains/image-processing/repo/image-processing-submission";
import { completeCloudImageDescription } from "~/server/domains/image-processing/service/cloud-description";
import { MAX_DESCRIPTION_RENDITION_BYTES } from "~/server/domains/image-processing/service/cloud-limits";
import {
  deferCloudAttemptForTypedWait,
  prepareCompanionImageCommand,
  reserveCompanionAnalysisOutput,
} from "~/server/domains/image-processing/service/dispatch";
import { safeImageProcessingError } from "~/server/domains/image-processing/service/safe-error";
import { inspectImageFile } from "~/server/domains/image/repo/image-integrity";
import { imageDescriptionInputFingerprint } from "~/server/domains/image/service/image-description.service";
import { hasMeaningfulPngTransparency } from "~/server/domains/image/service/image-transparency";
import { reserveImageAnalysisInput } from "~/server/generic/activity/repo/activity-input";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

/**
 * Persist independent jobs before publishing their lightweight wakeups. The caller
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
  const scheduled = await persistImageProcessingSubmission(db, input);
  if (input.publish !== false)
    await publishImageProcessingWakeups(db, scheduled.jobIds);
  return scheduled;
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
  const bytes = await readResponseWithLimit(
    response,
    MAX_DESCRIPTION_RENDITION_BYTES,
  );
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
  const stageKey = imageAnalysisKey("staging", result.attemptId);
  if (
    !context ||
    context.kind !== "describe_image" ||
    context.processorRevision !== IMAGE_DESCRIPTION_PROCESSOR_REVISION ||
    context.contentType !== "image/avif" ||
    context.inputKey !== stageKey ||
    outcome.key !== stageKey
  )
    return { adopted: false };
  const snapshotKey = imageAnalysisKey("input", result.attemptId);
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
        imageId: parseEntityId("image", context.imageId),
        runId: context.runId,
        normalizedInput: { bytes, key: snapshotKey },
      }),
    };
  } catch (error) {
    // The verified JPEG stays retained under this attempt's input key; only
    // the provider call waits, without spending an attempt.
    if (await deferCloudAttemptForTypedWait(db, result, error))
      return { adopted: false };
    const completion = await completeImageProcessingJob(db, {
      result: {
        ...result,
        outcome: {
          kind: "describe_image",
          status: "failed",
          retryable: SERVER_FAILURE_RETRYABLE,
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
  };
}

export async function retryImageProcessingFailures(
  db: Database,
  input: { id: string },
) {
  const imageId = await resolveOrThrow(db, "image", input.id);
  const submission = await createImageProcessingSubmission(db);
  const jobs = await retryImageProcessingNow(db, {
    imageId,
    submissionId: submission.id,
  });
  await publishImageProcessingWakeups(db, jobs);
  return { retried: jobs.length, submissionId: submission.publicId };
}

/** What a device's hello declares about who runs a claimed job. */
export type CompanionDevice = Pick<
  z.infer<typeof imageProcessingHello>,
  | "deviceId"
  | "platform"
  | "appVersion"
  | "deviceName"
  | "osVersion"
  | "capabilities"
>;

/** Pulling grants one bounded assignment; the socket's foreground gate stays truthful. */
function companionClaimCapabilities(
  hello: Pick<CompanionDevice, "capabilities">,
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
    appleIntelligenceAvailable:
      hello.capabilities.actualImageDescription.available,
  });
  const empty = { command: null, remotePaused: participation.remotePaused };
  if (!participation.automaticWork || participation.remotePaused) return empty;
  // A newer Apple build may succeed where an older one kept failing: its
  // first pull makes backing-off device work due again.
  if (participation.appVersionChanged) await retryBackingOffDeviceWork(db);
  const command = await claimCompanionImageCommand(db, {
    device: hello,
    userId,
    leaseMs: input.leaseSeconds * 1000,
  });
  return command ? { command, remotePaused: false } : empty;
}

/** Candidates one pull may try when the server cannot hand a claim over. */
const COMPANION_CLAIM_TRIES = 3;
/** A hand-off that failed waits this long, so a persistent storage error cannot spin. */
const HANDOFF_RETRY_MS = 60_000;

/**
 * Claim and assign the next job a participating device can run, for the
 * device's `imageProcessing.pull`. A claim the server cannot hand over is
 * released (never an attempt) before anything returns: a null command means
 * an empty queue, never an abandoned lease. A failed hand-off throws, so the
 * device sees an error rather than an empty queue.
 */
export async function claimCompanionImageCommand(
  db: Database,
  input: {
    device: CompanionDevice;
    userId: string;
    leaseMs: number;
  },
): Promise<ImageProcessingCommand | null> {
  const { device } = input;
  const { revisions, kinds, allowAvifNormalization } =
    companionClaimCapabilities(device);
  if (!kinds.length) return null;
  for (let tries = 0; tries < COMPANION_CLAIM_TRIES; tries++) {
    const claimed = await claimImageProcessingJob(db, {
      kinds,
      processorRevisions: revisions,
      allowAvifNormalization,
      leaseMs: input.leaseMs,
      deviceId: device.deviceId,
    });
    if (!claimed) return null;
    const release = (reason: string, delayMs?: number) =>
      releaseImageProcessingLease(db, {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        reason,
        delayMs,
        event: "dispatch.released",
      });
    let command: ImageProcessingCommand;
    try {
      command = await prepareCompanionImageCommand(claimed);
    } catch (error) {
      await release(safeImageProcessingError(error), HANDOFF_RETRY_MS);
      throw error;
    }
    const assigned = await assignImageProcessingExecutor(db, {
      jobId: claimed.id,
      attemptId: claimed.attemptId,
      userId: input.userId,
      executor: {
        kind: "device",
        deviceId: device.deviceId,
        name: device.deviceName ?? "Apple device",
        platform: device.platform,
        appVersion: device.appVersion,
        osVersion: device.osVersion ?? null,
      },
    });
    if (!assigned) {
      // Participation flipped off after hello: this device takes nothing.
      await release("Device assignment was refused");
      return null;
    }
    if (await reserveCompanionAnalysisOutput(db, command)) return command;
    await release("Analysis output could not be reserved", HANDOFF_RETRY_MS);
  }
  return null;
}

export async function completeAssignedCompanionImageProcessing(
  db: Database,
  input: { deviceId: string; result: CompanionImageProcessingResult },
  userId: string,
) {
  if (
    !(await findImageProcessingDeviceAssignment(db, {
      jobId: input.result.jobId,
      attemptId: input.result.attemptId,
      deviceId: input.deviceId,
      userId,
    }))
  )
    return { adopted: false };
  return completeCompanionImageProcessingResult(db, input.result);
}
