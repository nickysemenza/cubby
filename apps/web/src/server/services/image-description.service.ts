import {
  parseShortcodeFor,
  type ImageId,
  type RunId,
} from "@cubby/schemas/identifiers";
import {
  IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
  IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
  type ImageDescriptionResult,
  imageDescriptionResult,
} from "@cubby/schemas/image-processing";
import {
  fetchExternalResponse,
  readResponseWithLimit,
  MAX_EXTERNAL_IMAGE_BYTES,
} from "@cubby/shared/external-fetch";
import { TIER1_NUTRIENTS } from "@cubby/usda";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";
import {
  type AiImagePart,
  runStructuredFeature,
} from "~/server/ai/run-feature";
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
export function imageAnalysisRenditionUrl(originalUrl: string): string {
  const parsed = new URL(originalUrl);
  return `${parsed.origin}/cdn-cgi/image/width=2048,fit=scale-down,format=jpeg${parsed.pathname}${parsed.search}`;
}

const RENDITION_ERROR_BODY_CHARS = 500;

/**
 * Fetch the edge rendition, refusing a non-2xx response. Without the check an
 * error page is read as image bytes and the job fails later with an unrelated
 * "must be JPEG" message that hides the real status.
 */
export async function fetchAnalysisRendition(
  url: string,
  fetcher?: typeof fetch,
): Promise<Uint8Array> {
  const response = await fetchExternalResponse(url, { fetcher });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Analysis rendition fetch failed: HTTP ${response.status} ${response.statusText}`.trimEnd() +
        (body ? `: ${body.slice(0, RENDITION_ERROR_BODY_CHARS)}` : ""),
    );
  }
  return await readResponseWithLimit(response, MAX_EXTERNAL_IMAGE_BYTES);
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
  promptRevision?: number;
  resultSchemaRevision?: number;
}): string {
  return JSON.stringify({
    renditionHash: input.renditionHash,
    feature: IMAGE_DESCRIPTION_FEATURE.feature,
    sourceContentHash: input.sourceContentHash,
    contentType: input.contentType,
    provider: input.provider,
    model: input.model,
    promptRevision:
      input.promptRevision ?? IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
    resultSchemaRevision:
      input.resultSchemaRevision ??
      IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
    normalizationRevision: IMAGE_ANALYSIS_NORMALIZATION_REVISION,
  });
}

export function descriptionRequest(imageUrl: string) {
  const imagePart: AiImagePart = {
    type: "image",
    source: { type: "url", value: imageUrl },
  };
  return {
    systemPrompts: [
      "Describe this one image accurately for a household catalog. Return only what visual evidence supports. Claims must distinguish visible labels/OCR from visual inference. Never infer material composition from appearance. When a Nutrition Facts panel is legible, return nutritionFacts with its printed serving grams and per-serving nutrient amounts in the declared units (kcal for energy, g for macronutrients, mg or micrograms as declared for micronutrients). Use only numeric amounts printed on this panel; do not use percent daily values as amounts. Preserve omitted nutrients as unknown. An exception is a printed footnote explicitly naming a nutrient as not a significant source: include only those named nutrients in inferredZeroNutrients, quote the exact printed footnote verbatim in inferenceEvidence and in an OCR or label claim, and leave their numeric amounts absent. Never infer zero from an otherwise sparse panel, an omitted nutrient, USDA data, or appearance. If there is no such explicit footnote, leave inferredZeroNutrients empty and inferenceEvidence null. If the panel or serving grams are unreadable, return nutritionFacts null. Mark cutout eligibility eligible only for one clearly isolated object; labels, documents, people, room scenes, and ambiguous groups are ineligible or review.",
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
  input: {
    imageId: ImageId;
    attemptId: string;
    runId: RunId;
    normalizedInput?: { bytes: Uint8Array; key: string };
  },
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
    promptRevision: IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
    schemaRevision: IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
    normalizationRevision: IMAGE_ANALYSIS_NORMALIZATION_REVISION,
    request: descriptionRequest(
      imageAnalysisRenditionUrl(getR2PublicUrl(source.key)),
    ),
    cached: false,
  });
  let analysisUrl = imageAnalysisRenditionUrl(getR2PublicUrl(source.key));
  // Companions receive a rewritable staging PUT, never this server-owned snapshot key.
  const key =
    input.normalizedInput?.key ??
    `cubby/analysis-inputs/${input.attemptId}-${crypto.randomUUID()}.jpg`;
  if (
    !input.normalizedInput &&
    !(await reserveImageAnalysisInput(db, input.attemptId, key))
  )
    throw new Error("Image analysis attempt is no longer current");
  const bytes =
    input.normalizedInput?.bytes ?? (await fetchAnalysisRendition(analysisUrl));
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
    promptVersion: String(IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION),
    resultSchemaRevision: IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
    inputFingerprint: fingerprint,
  });
  await recordImageDescriptionInput(db, {
    attemptId: input.attemptId,
    sourceHash: source.sha256,
    sourceKey: source.key,
    fingerprint,
    provider,
    model: IMAGE_DESCRIPTION_FEATURE.model,
    promptRevision: IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
    schemaRevision: IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
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
      entity: { entityKind: "image", entityId: source.id },
    },
  );
  const result = normalizeImageDescriptionResult(raw, source.shortcode);
  return { result, cached: false, fingerprint };
}

/** Proposed zeros require a quoted, explicitly named label footnote before human review. */
export function normalizeImageDescriptionResult(
  raw: unknown,
  sourceShortcode: string,
): ImageDescriptionResult {
  const parsed = imageDescriptionResult.parse(raw);
  const evidence = parsed.nutritionFacts?.inferenceEvidence ?? null;
  const quoted =
    evidence &&
    parsed.claims.some(
      (claim) =>
        claim.evidenceKind !== "visual" && claim.text.includes(evidence),
    );
  const footnoteClauses = quoted
    ? [
        ...evidence.matchAll(
          /\bnot\s+(?:a\s+)?significant\s+source\s+of\s+([^.!?;\r\n]+)/gi,
        ),
      ].map((match) => match[1] ?? "")
    : [];
  const inferredZeroNutrients = footnoteClauses.length
    ? (parsed.nutritionFacts?.inferredZeroNutrients ?? []).filter((key) => {
        const name = TIER1_NUTRIENTS[key].displayName.toLowerCase();
        const named = name.endsWith("s") ? `${name.slice(0, -1)}s?` : name;
        return footnoteClauses.some((clause) =>
          new RegExp(`\\b${named}\\b`, "i").test(clause),
        );
      })
    : [];
  return imageDescriptionResult.parse({
    ...parsed,
    claims: parsed.claims.map((claim) => ({
      ...claim,
      imageId: parseShortcodeFor("image", sourceShortcode),
    })),
    nutritionFacts: parsed.nutritionFacts
      ? {
          ...parsed.nutritionFacts,
          inferredZeroNutrients,
          inferenceEvidence: inferredZeroNutrients.length ? evidence : null,
        }
      : null,
  });
}
