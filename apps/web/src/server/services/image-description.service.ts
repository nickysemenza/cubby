import { parseShortcodeFor, type ImageId } from "@cubby/schemas/identifiers";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
  type ImageDescriptionResult,
  imageDescriptionResult,
} from "@cubby/schemas/image-processing";
import type { ImagePart } from "@tanstack/ai";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import { runStructuredFeature } from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { IMAGE_ANALYSIS_NORMALIZATION_REVISION } from "~/server/image-processing/description-policy";
import {
  findCachedImageDescriptionAnalysis,
  getUploadedImageProcessingSource,
  saveImageDescriptionAnalysis,
} from "~/server/repo/image-processing";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

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
}): string {
  return JSON.stringify({
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
  input: { imageId: ImageId; jobId?: string | null },
): Promise<{ result: ImageDescriptionResult; cached: boolean }> {
  const source = await getUploadedImageProcessingSource(db, input.imageId);
  if (!source) {
    throw new Error("Image must be uploaded and integrity-verified first");
  }
  const provider = providerFor(IMAGE_DESCRIPTION_FEATURE.model);
  const fingerprint = imageDescriptionInputFingerprint({
    sourceContentHash: source.sha256,
    contentType: source.contentType,
    provider,
    model: IMAGE_DESCRIPTION_FEATURE.model,
  });
  const cached = await findCachedImageDescriptionAnalysis(db, {
    imageId: source.id,
    provider,
    model: IMAGE_DESCRIPTION_FEATURE.model,
    promptVersion: String(IMAGE_DESCRIPTION_PROMPT_REVISION),
    resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
    inputFingerprint: fingerprint,
  });
  if (cached)
    return { result: imageDescriptionResult.parse(cached), cached: true };

  const raw = await runStructuredFeature(
    IMAGE_DESCRIPTION_FEATURE,
    descriptionRequest(imageAnalysisRenditionUrl(getR2PublicUrl(source.key))),
    {
      db,
      operation: "imageDescription",
      job: input.jobId ? { kind: "describe_image", id: input.jobId } : null,
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
  await saveImageDescriptionAnalysis(db, {
    imageId: source.id,
    provider,
    model: IMAGE_DESCRIPTION_FEATURE.model,
    promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
    resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
    inputFingerprint: fingerprint,
    result,
  });
  return { result, cached: false };
}
