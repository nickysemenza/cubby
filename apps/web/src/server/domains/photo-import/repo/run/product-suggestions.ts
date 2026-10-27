import { runEntityId } from "@cubby/schemas/identifiers";
import type { PhotoGroupReview } from "@cubby/schemas/photo-import-run";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { loadImageAnalysisEvidence } from "~/server/domains/image/repo/image-analysis-summary";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { canonicalJson } from "~/server/lib/canonical-json";

/** Photo drafts use the shared immutable review history without entering automatic application. */
export async function photoProductSuggestions(
  db: Database,
  input: {
    runId: string;
    groupKey: string;
    productId: string;
    review: PhotoGroupReview;
    imageIds: string[];
  },
): Promise<NonNullable<PhotoGroupReview["fieldSuggestions"]>> {
  const runId =
    runEntityId.safeParse(input.runId).data ??
    (await resolveOrThrow(db, "run", input.runId));
  const id = await resolveOrThrow(db, "product", input.productId);
  const [current] = await getDb(db)
    .select()
    .from(product)
    .where(eq(product.id, id));
  if (!current) throw new Error("Selected Product no longer exists");
  const imageEvidence = await loadImageAnalysisEvidence(db, input.imageIds);
  const photoEvidence = input.imageIds.map((imageId) => ({
    imageId,
    recognizedText:
      imageEvidence.summaries.get(imageId)?.recognizedText ?? null,
    description: imageEvidence.descriptionEvidence.get(imageId) ?? null,
  }));
  const currentFields = z.record(z.string(), z.unknown()).parse(current);
  const suggestions: NonNullable<PhotoGroupReview["fieldSuggestions"]> = [];
  for (const [field, raw] of Object.entries(
    input.review.productChanges ?? {},
  )) {
    if (
      field === "brandCreate" ||
      (field === "brandId" && input.review.productChanges?.brandCreate) ||
      raw === undefined
    )
      continue;
    const value = z.json().parse(raw);
    const fingerprint = await fieldInputFingerprint(db, "product", id, field);
    const key = await sha256Hex(
      canonicalJson({
        runId,
        groupKey: input.groupKey,
        productId: id,
        field,
        value,
        fingerprint,
        photoEvidence,
        observedName: input.review.observedName,
      }),
    );
    const currentValue = z.json().parse(currentFields[field] ?? null);
    const saved = await publishAssessment(
      db,
      {
        publicationKey: `photo-field:${key}`,
        family: "field",
        subject: { kind: "field", entity: "product", recordId: id, field },
        judgment: {
          value,
          confidence: 0,
          runnerUpValue: null,
          runnerUpConfidence: null,
          kind: currentValue === null ? "addition" : "correction",
        },
        fingerprint,
        producer: null,
        evidence: {
          runId,
          groupKey: input.groupKey,
          observedName: input.review.observedName,
          photoEvidence: z.json().parse(photoEvidence),
          currentValue,
        },
        served: true,
      },
      {
        entity: "product",
        recordId: id,
        field,
        currentValue,
        suggestedValue: value,
        confidence: 0,
        model: "photo-review",
        status: "pending",
        active: false,
        kind: currentValue === null ? "addition" : "correction",
        data: {
          liveInputFingerprint: fingerprint,
          photoReview: { runId, groupKey: input.groupKey },
        },
      },
    );
    suggestions.push({ id: saved.id, field, value });
  }
  return suggestions;
}
