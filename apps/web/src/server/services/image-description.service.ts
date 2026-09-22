import {
  parseShortcodeFor,
  type ImageId,
  type ImportRunId,
} from "@cubby/schemas/identifiers";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
  type ImageDescriptionResult,
  imageDescriptionResult,
} from "@cubby/schemas/image-processing";
import {
  fetchExternalResponse,
  readResponseWithLimit,
  MAX_EXTERNAL_IMAGE_BYTES,
} from "@cubby/shared/external-fetch";
import type { ImagePart } from "@tanstack/ai";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { IMAGE_ANALYSIS_NORMALIZATION_REVISION } from "~/server/image-processing/description-policy";
import {
  recordImageDescriptionInput,
  reserveImageAnalysisInput,
  retainImageAnalysisInput,
} from "~/server/repo/activity-input";
import {
  findCachedImageDescriptionAnalysis,
  getUploadedImageProcessingSource,
} from "~/server/repo/image-processing";
import { inspectImageFile } from "~/server/services/image-integrity";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";
import { uploadToS3 } from "~/server/utils/s3";

/**
 * The edge rendition normalizes EXIF/HEIF orientation and requests a provider-
 * compatible JPEG without mutating or replacing the original attachment.
 */
function imageAnalysisRenditionUrl(originalUrl: string): string {
  const parsed = new URL(originalUrl);
  return `${parsed.origin}/cdn-cgi/image/width=2048,fit=scale-down,format=jpeg${parsed.pathname}${parsed.search}`;
}

/**
 * Includes only bytes and declared AI inputs. Timestamps and perceptual hashes
 * are deliberately absent: neither tells us whether the model saw new pixels.
 */
export function imageDescriptionInputFingerprint(input: {
  sourceContentHash: string;
  contentType: string;
  model: string;
  provider: string;
  renditionHash?: string;
}): string {
  return JSON.stringify({
    renditionHash: input.renditionHash,
    feature: IMAGE_DESCRIPTION_FEATURE.feature,
    sourceContentHash: input.sourceContentHash,
    contentType: input.contentType,
    provider: input.provider,
    model: input.model,
    promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
    resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
    normalizationRevision: IMAGE_ANALYSIS_NORMALIZATION_REVISION,
  });
}

function descriptionRequest(imageUrl: string) {
  const imagePart: ImagePart = {
    type: "image",
    source: { type: "url", value: imageUrl },
  };
  return {
    systemPrompts: [
      "Describe this one image accurately for a household catalog. Return only what visual evidence supports. Claims must distinguish visible labels/OCR from visual inference. Never infer material composition from appearance. Mark cutout eligibility eligible only for one clearly isolated object; labels, documents, people, room scenes, and ambiguous groups are ineligible or review.",
    ],
    messages: [
      {
        role: "user" as const,
        content: [
          imagePart,
          {
            type: "text" as const,
            content:
              "Analyze the original image. Do not describe a generated cutout.",
          },
        ],
      },
    ],
  };
}

/**
 * Preferred cloud analysis through the mandatory AI Gateway. A matching
 * immutable AiAnalysis result is returned before any model request is placed.
 */
export async function describeOriginalImage(
  db: Database,
  input: { imageId: ImageId; attemptId: string; runId: ImportRunId },
): Promise<{
  result: ImageDescriptionResult;
  cached: boolean;
  fingerprint: string;
}> {
  const source = await getUploadedImageProcessingSource(db, input.imageId);
  if (!source) {
    throw new Error("Image must be uploaded and integrity-verified first");
  }
  const provider = providerFor(IMAGE_DESCRIPTION_FEATURE.model);
  let fingerprint = imageDescriptionInputFingerprint({
    sourceContentHash: source.sha256,
    contentType: source.contentType,
    provider,
    model: IMAGE_DESCRIPTION_FEATURE.model,
  });
  await recordImageDescriptionInput(db, {
    attemptId: input.attemptId,
    sourceHash: source.sha256,
    sourceKey: source.key,
    fingerprint,
    provider,
    model: IMAGE_DESCRIPTION_FEATURE.model,
    promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
    schemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
    normalizationRevision: IMAGE_ANALYSIS_NORMALIZATION_REVISION,
    request: descriptionRequest(
      imageAnalysisRenditionUrl(getR2PublicUrl(source.key)),
    ),
    cached: false,
  });
  let analysisUrl = imageAnalysisRenditionUrl(getR2PublicUrl(source.key));
  const key = `cubby/analysis-inputs/${input.attemptId}.jpg`;
  if (!(await reserveImageAnalysisInput(db, input.attemptId, key)))
    throw new Error("Image analysis attempt is no longer current");
  const response = await fetchExternalResponse(analysisUrl);
  const bytes = await readResponseWithLimit(response, MAX_EXTERNAL_IMAGE_BYTES);
  const inspected = await inspectImageFile(bytes, "image/jpeg");
  if (inspected.detectedContentType !== "image/jpeg")
    throw new Error("Analysis rendition must be JPEG");
  await uploadToS3({
    key,
    body: Buffer.from(bytes),
    contentType: "image/jpeg",
  });
  if (!(await retainImageAnalysisInput(db, input.attemptId, key)))
    throw new Error("Image was removed during analysis input upload");
  analysisUrl = getR2PublicUrl(key);
  fingerprint = imageDescriptionInputFingerprint({
    sourceContentHash: source.sha256,
    contentType: source.contentType,
    provider,
    model: IMAGE_DESCRIPTION_FEATURE.model,
    renditionHash: inspected.sha256,
  });
  const exactCached = await findCachedImageDescriptionAnalysis(db, {
    imageId: source.id,
    provider,
    model: IMAGE_DESCRIPTION_FEATURE.model,
    promptVersion: String(IMAGE_DESCRIPTION_PROMPT_REVISION),
    resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
    inputFingerprint: fingerprint,
  });
  await recordImageDescriptionInput(db, {
    attemptId: input.attemptId,
    sourceHash: source.sha256,
    sourceKey: source.key,
    fingerprint,
    provider,
    model: IMAGE_DESCRIPTION_FEATURE.model,
    promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
    schemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
    normalizationRevision: IMAGE_ANALYSIS_NORMALIZATION_REVISION,
    request: descriptionRequest(analysisUrl),
    cached: Boolean(exactCached),
    renditionKey: key,
    renditionHash: inspected.sha256,
  });
  if (exactCached)
    return {
      result: imageDescriptionResult.parse(exactCached),
      cached: true,
      fingerprint,
    };
  const raw = await runStructuredFeature(
    IMAGE_DESCRIPTION_FEATURE,
    descriptionRequest(analysisUrl),
    {
      db,
      runId: input.runId,
      operation: "imageDescription",
      job: { kind: "image_processing_attempt", id: input.attemptId },
      cacheStatus: "miss",
      entity: { entityType: "image", entityId: source.id },
    },
  );
  const result = imageDescriptionResult.parse({
    ...raw,
    claims: raw.claims.map((claim) => ({
      ...claim,
      // Claims are evidence about this source image only. Do not accept a
      // model-supplied reference to another household image.
      imageId: parseShortcodeFor("image", source.shortcode),
    })),
  });
  return { result, cached: false, fingerprint };
}
