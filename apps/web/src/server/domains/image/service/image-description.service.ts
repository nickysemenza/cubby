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
import { providerFor, type SupportedChatModel } from "@cubby/shared/ai/models";
import {
  fetchExternalResponse,
  readResponseWithLimit,
} from "@cubby/shared/external-fetch";
import { TIER1_NUTRIENTS } from "@cubby/usda";

import { transformedImageUrl } from "~/lib/image-url";
import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/policy/features";
import { runStructuredFeature } from "~/server/ai/run-feature";
import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import { imageAnalysisKey, uploadToS3 } from "~/server/clients/s3";
import type { Database } from "~/server/db";
import {
  IMAGE_ANALYSIS_NORMALIZATION_REVISION,
  imageDescriptionInputFingerprint,
} from "~/server/domains/image-processing/repo/description-policy";
import {
  findCachedImageDescriptionAnalysis,
  getUploadedImageProcessingSource,
} from "~/server/domains/image-processing/repo/image-processing";
import {
  DESCRIPTION_RENDITION_EDGE,
  MAX_ANALYSIS_FALLBACK_SOURCE_BYTES,
  MAX_DESCRIPTION_RENDITION_BYTES,
} from "~/server/domains/image-processing/service/cloud-limits";
import { prepareAnalysisPng } from "~/server/domains/image-processing/service/model-image";
import { inspectImageFile } from "~/server/domains/image/repo/image-integrity";
import {
  recordImageDescriptionInput,
  reserveImageAnalysisInput,
  retainImageAnalysisInput,
} from "~/server/generic/activity/repo/activity-input";

/**
 * The edge rendition normalizes EXIF/HEIF orientation and requests a provider-
 * compatible JPEG without mutating or replacing the original attachment.
 */
export function imageAnalysisRenditionUrl(originalUrl: string): string {
  // An unbounded rendered width snaps to the largest rung.
  return transformedImageUrl(originalUrl, Number.POSITIVE_INFINITY, {
    format: "jpeg",
    anyOrigin: true,
  });
}

const RENDITION_ERROR_BODY_CHARS = 500;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Fetch the edge rendition, refusing a non-2xx response. Without the check an
 * error page is read as image bytes and the job fails later with an unrelated
 * "must be JPEG" message that hides the real status.
 *
 * The edge answers 422 when it cannot decode the source. Its PNG decoder
 * rejects files our decoder accepts (a damaged ancillary chunk around intact
 * pixels), so a refused PNG is normalized in-process to the same bounds rather
 * than retried against the same deterministic refusal.
 */
export async function fetchAnalysisRendition(input: {
  sourceUrl: string;
  renditionUrl: string;
  maxEdge: number;
  maxBytes: number;
  fetcher?: typeof fetch;
}): Promise<Uint8Array> {
  const { fetcher, maxBytes } = input;
  const response = await fetchExternalResponse(input.renditionUrl, {
    fetcher,
  });
  if (response.ok) return await readResponseWithLimit(response, maxBytes);
  const body = await response.text().catch(() => "");
  const refusal = new Error(
    `Analysis rendition fetch failed: HTTP ${response.status} ${response.statusText}`.trimEnd() +
      (body ? `: ${body.slice(0, RENDITION_ERROR_BODY_CHARS)}` : ""),
  );
  if (response.status !== 422) throw refusal;
  const original = await fetchExternalResponse(input.sourceUrl, { fetcher });
  if (!original.ok) throw refusal;
  const bytes = await readResponseWithLimit(
    original,
    MAX_ANALYSIS_FALLBACK_SOURCE_BYTES,
  );
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value))
    throw refusal;
  try {
    return prepareAnalysisPng(bytes, input.maxEdge, maxBytes);
  } catch (error) {
    throw new Error(`${refusal.message}; in-process PNG normalization failed`, {
      cause: error,
    });
  }
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
  /** The model that produced the description; the declared one on a stored-analysis hit. */
  model: SupportedChatModel;
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
    request: IMAGE_DESCRIPTION_FEATURE.request(
      imageAnalysisRenditionUrl(getR2PublicUrl(source.key)),
    ),
    cached: false,
  });
  const sourceUrl = getR2PublicUrl(source.key);
  let analysisUrl = imageAnalysisRenditionUrl(sourceUrl);
  // Companions receive a rewritable staging PUT, never this server-owned snapshot key.
  const key =
    input.normalizedInput?.key ?? imageAnalysisKey("input", input.attemptId);
  if (
    !input.normalizedInput &&
    !(await reserveImageAnalysisInput(db, input.attemptId, key))
  )
    throw new Error("Image analysis attempt is no longer current");
  const bytes =
    input.normalizedInput?.bytes ??
    (await fetchAnalysisRendition({
      sourceUrl,
      renditionUrl: analysisUrl,
      maxEdge: DESCRIPTION_RENDITION_EDGE,
      maxBytes: MAX_DESCRIPTION_RENDITION_BYTES,
    }));
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
    request: IMAGE_DESCRIPTION_FEATURE.request(analysisUrl),
    cached: Boolean(exactCached),
    renditionKey: key,
    renditionHash: inspected.sha256,
  });
  if (exactCached)
    return {
      result: imageDescriptionResult.parse(exactCached),
      cached: true,
      fingerprint,
      model: IMAGE_DESCRIPTION_FEATURE.model,
    };
  let model: SupportedChatModel = IMAGE_DESCRIPTION_FEATURE.model;
  const raw = await runStructuredFeature(
    IMAGE_DESCRIPTION_FEATURE,
    IMAGE_DESCRIPTION_FEATURE.request(analysisUrl),
    {
      db,
      runId: input.runId,
      operation: "imageDescription",
      job: { kind: "image_processing_attempt", id: input.attemptId },
      cacheStatus: "miss",
      entity: { entityKind: "image", entityId: source.id },
      onAnswered: (answered) => {
        model = answered;
      },
    },
  );
  const result = normalizeImageDescriptionResult(raw, source.shortcode);
  return { result, cached: false, fingerprint, model };
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
