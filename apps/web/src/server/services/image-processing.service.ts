import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import type {
  ImageProcessingJobKind,
  ImageProcessingResult,
} from "@cubby/schemas/image-processing";

import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import {
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  completeImageProcessingJob,
  createImageProcessingJob,
  createTransparentDerivativeAndJob,
  getLeasedImageProcessingOutputKey,
  claimImageProcessingOrphans,
  finalizeImageProcessingOrphans,
  getLeasedImageProcessingJobContext,
  getUploadedImageProcessingSource,
} from "~/server/repo/image-processing";
import { readImageProcessingSettings } from "~/server/repo/image-processing-maintenance";
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
  },
): Promise<{ jobIds: string[] }> {
  const settings = await readImageProcessingSettings(db);
  if (input.automatic && !settings.enabled) return { jobIds: [] };
  const imageId = await resolveOrThrow(db, "image", input.id);
  const source = await getUploadedImageProcessingSource(db, imageId);
  if (!source)
    throw new Error("Image must be uploaded and integrity-verified first");

  const jobIds: string[] = [];
  for (const kind of new Set(input.kinds)) {
    if (kind === "subject_lift") {
      const scheduled = await createTransparentDerivativeAndJob(db, {
        imageId,
        sourceContentHash: source.sha256,
        // Every actual dispatch rotates this placeholder to a fresh key.
        key: `pending/${crypto.randomUUID()}.png`,
      });
      if (scheduled) jobIds.push(scheduled.jobId);
      continue;
    }
    const jobId = await createImageProcessingJob(db, {
      imageId,
      kind,
      sourceContentHash: source.sha256,
      processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
    });
    if (jobId) jobIds.push(jobId);
  }
  const unique = [...new Set(jobIds)];
  if (input.publish !== false && !settings.paused)
    await publishImageProcessingWakeups(db, unique);
  return { jobIds: unique };
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
  const imageId = await resolveOrThrow(db, "image", input.id);
  const source = await getUploadedImageProcessingSource(db, imageId);
  if (!source)
    throw new Error("Image must be uploaded and integrity-verified first");
  const jobId = await createImageProcessingJob(db, {
    imageId,
    kind: "describe_image",
    sourceContentHash: source.sha256,
    processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  });
  if (jobId) await publishImageProcessingWakeups(db, [jobId]);
  return { jobId };
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
  result: ImageProcessingResult,
): Promise<{ adopted: boolean }> {
  const prepared = await prepareCompanionCompletion(db, result);
  if (!prepared) return { adopted: false };
  const completion = await completeImageProcessingJob(db, prepared.input);
  if (completion.adopted && prepared.searchImageId)
    await refreshDirectImageOwnerSearchDocuments(db, prepared.searchImageId);
  return { adopted: completion.adopted };
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
    const reason =
      error instanceof Error
        ? error.message
        : "Transparent output validation failed";
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
        }),
      },
    },
    searchImageId: context.imageId,
  };
}
