import { imageAnalysisSummarySchema } from "@cubby/schemas/image";
import type { ImageAnalysisSummary } from "@cubby/schemas/image";
import { imageDescriptionResult } from "@cubby/schemas/image-processing";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { aiAnalysis, image } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";

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

/**
 * Newest non-deleted row per image (keyed by the public `IMG-` shortcode) for
 * one `aiAnalysis` feature, in one query. Joins to `Image` rather than taking
 * internal ids because `aiAnalysis.entityId` is a uuid this reader's own
 * callers don't all have on hand — the Product mapper's image rows carry only
 * the shortcode (`MappableImageRecord` deliberately drops the uuid).
 */
async function loadNewestAnalysisByImage(
  db: Database | DrizzleTransaction,
  imageShortcodes: readonly string[],
  feature: string,
): Promise<Map<string, unknown>> {
  const rows = await unwrapDb(db)
    .select({ shortcode: image.shortcode, result: aiAnalysis.result })
    .from(aiAnalysis)
    .innerJoin(image, eq(image.id, aiAnalysis.entityId))
    .where(
      and(
        eq(aiAnalysis.entityKind, "image"),
        inArray(image.shortcode, [...imageShortcodes]),
        eq(aiAnalysis.feature, feature),
        isNull(aiAnalysis.deletedAt),
      ),
    )
    .orderBy(desc(aiAnalysis.createdAt));
  const newest = new Map<string, unknown>();
  for (const row of rows) {
    // Ordered newest-first: the first row seen per image wins.
    if (!newest.has(row.shortcode)) {
      newest.set(row.shortcode, row.result);
    }
  }
  return newest;
}

/**
 * Batched analysis summary for a page of images: the newest non-deleted
 * `photo-local-analysis` (on-device Vision) and `image-description` (cloud)
 * `AiAnalysis` row per image, condensed to what the photo-inventory-import
 * agent needs to decide whether an image is worth opening — top
 * classifications, OCR text joined into lines, and the cloud description.
 *
 * One query per feature (not one per image); a caller with N images on a page
 * makes exactly two round trips here regardless of N. Keyed by the public
 * `IMG-` shortcode, matching every other batched image loader in this repo
 * (`loadImageRepresentations`, `loadImageProcessingIssues`). An image with
 * neither feature analyzed yet is simply absent from the returned map —
 * callers read that as `analysisSummary: null`.
 */
export async function loadImageAnalysisSummaries(
  db: Database | DrizzleTransaction,
  imageShortcodes: readonly string[],
): Promise<Map<string, ImageAnalysisSummary>> {
  const shortcodes = [...new Set(imageShortcodes)];
  if (shortcodes.length === 0) return new Map();

  const [localByImage, descriptionByImage] = await Promise.all([
    loadNewestAnalysisByImage(db, shortcodes, "photo-local-analysis"),
    loadNewestAnalysisByImage(db, shortcodes, "image-description"),
  ]);

  const summaries = new Map<string, ImageAnalysisSummary>();
  for (const shortcode of shortcodes) {
    const localRaw = localByImage.get(shortcode);
    const descriptionRaw = descriptionByImage.get(shortcode);
    if (localRaw === undefined && descriptionRaw === undefined) continue;

    const local = localRaw ? localAnalysisRowSchema.safeParse(localRaw) : null;
    const description = descriptionRaw
      ? imageDescriptionResult.safeParse(descriptionRaw)
      : null;

    const classifications = local?.success
      ? [...local.data.classifications]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 3)
          .map((entry) => entry.identifier)
      : [];
    const recognizedText =
      local?.success && local.data.recognizedText.length > 0
        ? local.data.recognizedText.map((entry) => entry.text).join("\n")
        : null;

    summaries.set(
      shortcode,
      imageAnalysisSummarySchema.parse({
        description: description?.success ? description.data.description : null,
        classifications,
        recognizedText,
      }),
    );
  }
  return summaries;
}
