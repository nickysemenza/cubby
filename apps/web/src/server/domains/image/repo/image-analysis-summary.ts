import { imageAnalysisSummarySchema } from "@cubby/schemas/image";
import type { ImageAnalysisSummary } from "@cubby/schemas/image";
import type { ImageIdentificationResult } from "@cubby/schemas/image-identification";
import { imageDescriptionResult } from "@cubby/schemas/image-processing";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import { aiAnalysis, image } from "~/server/db/schema";
import { loadImageIdentifications } from "~/server/domains/image/repo/image-identification";

import { loadSelectedDescriptionEvidence } from "./image-description-selection";

/**
 * The slice of an on-device `photo-local-analysis` row this reader needs.
 * Deliberately narrower than the full local-analysis payload (which also
 * carries `sha256`/`featurePrint`/`provenance` etc. for import reconciliation,
 * owned by `~/contracts/photo-import.contract`) — a row failing this laxer
 * parse still contributes nothing rather than dropping the whole summary.
 */
const localAnalysisRowSchema = z.object({
  classifications: z
    .array(z.object({ identifier: z.string(), confidence: z.number() }))
    .default([]),
  recognizedText: z
    .array(z.object({ text: z.string(), confidence: z.number() }))
    .default([]),
});

/** The identification input has already passed the retained reader's freshness and live-Product guards. */
export function composeImageAnalysisSummary(
  localRaw: unknown,
  descriptionRaw: unknown,
  identification?: ImageIdentificationResult,
): ImageAnalysisSummary | null {
  const local = localAnalysisRowSchema.safeParse(localRaw);
  const description = imageDescriptionResult.safeParse(descriptionRaw);
  if (!local.success && !description.success && identification === undefined)
    return null;
  return imageAnalysisSummarySchema.parse({
    description: description?.success ? description.data.description : null,
    classifications: local?.success
      ? [...local.data.classifications]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 3)
          .map((entry) => entry.identifier)
      : [],
    recognizedText:
      local?.success && local.data.recognizedText.length > 0
        ? local.data.recognizedText.map((entry) => entry.text).join("\n")
        : null,
    ...(identification === undefined ? {} : { identification }),
  });
}

/**
 * Newest non-deleted row per image (keyed by the public `IMG-` shortcode) for
 * local analysis, in one query. SQL selects one row and only classifications/OCR
 * per image; full historical payloads stay in retained storage. Equal timestamps
 * use descending IDs, matching the retained history tie policy. Joins to `Image` rather than taking
 * internal ids because `aiAnalysis.entityId` is a uuid this reader's own
 * callers don't all have on hand — the Product mapper's image rows carry only
 * the shortcode (`MappableImageRecord` deliberately drops the uuid).
 */
async function loadNewestLocalAnalysisByImage(
  db: Database | DrizzleTransaction,
  imageShortcodes: readonly string[],
): Promise<Map<string, unknown>> {
  const latest = unwrapDb(db)
    .selectDistinctOn([image.shortcode], {
      shortcode: image.shortcode,
      result: aiAnalysis.result,
    })
    .from(aiAnalysis)
    .innerJoin(image, eq(image.id, aiAnalysis.entityId))
    .where(
      and(
        eq(aiAnalysis.entityKind, "image"),
        inArray(image.shortcode, [...imageShortcodes]),
        eq(aiAnalysis.feature, "photo-local-analysis"),
        notDeleted(aiAnalysis),
      ),
    )
    .orderBy(image.shortcode, desc(aiAnalysis.createdAt), desc(aiAnalysis.id))
    .as("newest_local_analysis");
  // Select the winners before inspecting JSON, so history is not detoasted
  // just to discard it. Missing keys default to [], explicit null stays invalid.
  const rows = await unwrapDb(db)
    .select({
      shortcode: latest.shortcode,
      result: sql<unknown>`CASE WHEN jsonb_typeof(${latest.result}) = 'object' THEN
        CASE WHEN ${latest.result} ? 'classifications'
          THEN jsonb_build_object('classifications', ${latest.result}->'classifications') ELSE '{}'::jsonb END
        || CASE WHEN ${latest.result} ? 'recognizedText'
          THEN jsonb_build_object('recognizedText', ${latest.result}->'recognizedText') ELSE '{}'::jsonb END
        ELSE 'null'::jsonb END`,
    })
    .from(latest);
  return new Map(rows.map((row) => [row.shortcode, row.result]));
}

/**
 * Batched analysis summary for a page of images: the newest non-deleted
 * `photo-local-analysis` (on-device Vision) and selected `image-description`
 * `AiAnalysis` row per image, condensed to what the photo-inventory-import
 * agent needs to decide whether an image is worth opening — top
 * classifications, OCR text joined into lines, the corrected/preferred current description, and
 * current unconfirmed Product suggestions or identification abstention.
 *
 * Every feature is loaded in a batch, including freshness and live-Product
 * filtering for identification; query count stays independent of page size.
 * Both summary and description-evidence maps are keyed by the public
 * `IMG-` shortcode, matching every other batched image loader in this repo
 * (`loadImageRepresentations`, `loadImageProcessingIssues`). An image with
 * no retained analysis yet is simply absent from the summary map —
 * callers read that as `analysisSummary: null`.
 */
export async function loadImageAnalysisEvidence(
  db: Database | DrizzleTransaction,
  imageShortcodes: readonly string[],
) {
  const shortcodes = [...new Set(imageShortcodes)];
  if (shortcodes.length === 0)
    return {
      summaries: new Map<string, ImageAnalysisSummary>(),
      descriptionEvidence: await loadSelectedDescriptionEvidence(
        db,
        shortcodes,
      ),
    };

  const [localByImage, descriptionEvidence, identificationByImage] =
    await Promise.all([
      loadNewestLocalAnalysisByImage(db, shortcodes),
      loadSelectedDescriptionEvidence(db, shortcodes),
      loadImageIdentifications(db, shortcodes),
    ]);

  const summaries = new Map<string, ImageAnalysisSummary>();
  for (const shortcode of shortcodes) {
    const description = descriptionEvidence.get(shortcode)?.description;
    const summary = composeImageAnalysisSummary(
      localByImage.get(shortcode),
      description
        ? {
            description,
            claims: [],
            cutoutEligibility: "review",
          }
        : undefined,
      identificationByImage.get(shortcode)?.result,
    );
    if (summary) summaries.set(shortcode, summary);
  }
  return { summaries, descriptionEvidence };
}

/** Summary-only consumers project from the same selected evidence. */
export async function loadImageAnalysisSummaries(
  db: Database | DrizzleTransaction,
  imageShortcodes: readonly string[],
): Promise<Map<string, ImageAnalysisSummary>> {
  return (await loadImageAnalysisEvidence(db, imageShortcodes)).summaries;
}
