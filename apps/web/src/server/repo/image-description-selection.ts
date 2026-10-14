import {
  imageDescriptionResult,
  selectImageDescription,
} from "@cubby/schemas/image-processing";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { aiAnalysis, image, assessmentState } from "~/server/db/schema";
import {
  isCurrentPreferredImageDescription,
  parseImageDescriptionInputFingerprint,
} from "~/server/image-processing/description-policy";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";

/** Source-fenced descriptions and confirmed corrections are loaded in batches. */
export async function loadSelectedDescriptions(
  db: Database | DrizzleTransaction,
  shortcodes: string[],
) {
  if (!shortcodes.length) return new Map<string, string>();
  const rows = await unwrapDb(db)
    .select({
      shortcode: image.shortcode,
      hash: image.sha256,
      result: aiAnalysis.result,
      inputFingerprint: aiAnalysis.inputFingerprint,
      provider: aiAnalysis.provider,
      model: aiAnalysis.model,
      promptRevision: aiAnalysis.promptVersion,
      resultSchemaRevision: aiAnalysis.resultSchemaRevision,
    })
    .from(aiAnalysis)
    .innerJoin(image, eq(image.id, aiAnalysis.entityId))
    .where(
      and(
        inArray(image.shortcode, shortcodes),
        notDeleted(image),
        notDeleted(aiAnalysis),
        eq(aiAnalysis.entityKind, "image"),
        eq(aiAnalysis.feature, "image-description"),
      ),
    )
    .orderBy(desc(aiAnalysis.createdAt));
  const corrections = await unwrapDb(db)
    .select({
      shortcode: image.shortcode,
      description: sql<string>`${assessmentState.confirmedValue}->>'value'`,
    })
    .from(assessmentState)
    .innerJoin(image, eq(image.id, assessmentState.recordId))
    .where(
      and(
        inArray(image.shortcode, shortcodes),
        notDeleted(image),
        eq(assessmentState.active, true),
        eq(assessmentState.family, "image_description"),
        sql`${assessmentState.confirmedValue} @> ${JSON.stringify({ present: true })}::jsonb`,
      ),
    );
  const correctionsByImage = new Map(
    corrections.map((entry) => [entry.shortcode, entry]),
  );
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const entries = grouped.get(row.shortcode) ?? [];
    entries.push(row);
    grouped.set(row.shortcode, entries);
  }
  const selected = new Map<string, string>();
  for (const [shortcode, entries] of grouped) {
    const analyses = entries.flatMap((entry) => {
      const result = imageDescriptionResult.safeParse(entry.result);
      const fingerprint = parseImageDescriptionInputFingerprint(
        entry.inputFingerprint,
      );
      if (!result.success) return [];
      return [
        {
          result: result.data,
          inputFingerprint: entry.inputFingerprint,
          preferred:
            fingerprint !== null &&
            isCurrentPreferredImageDescription(fingerprint, {
              sourceContentHash: entry.hash,
              provider: entry.provider,
              model: entry.model,
              promptRevision: Number(entry.promptRevision),
              resultSchemaRevision: entry.resultSchemaRevision,
            }),
        },
      ];
    });
    const correction = correctionsByImage.get(shortcode) ?? null;
    const description = selectImageDescription(
      analyses,
      correction,
      entries[0]?.hash ?? null,
    );
    if (description) selected.set(shortcode, description);
  }
  for (const correction of corrections)
    selected.set(correction.shortcode, correction.description);
  return selected;
}
