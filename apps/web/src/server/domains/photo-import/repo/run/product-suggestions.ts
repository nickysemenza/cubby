import {
  assessmentSubjects,
  assessmentJudgments,
} from "@cubby/schemas/assessment";
import { runEntityId } from "@cubby/schemas/identifiers";
import type { PhotoGroupReview } from "@cubby/schemas/photo-import-run";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { product, assessment, assessmentState } from "~/server/db/schema";
import { loadImageAnalysisEvidence } from "~/server/domains/image/repo/image-analysis-summary";
import { publishAssessment } from "~/server/generic/assessment/repo/assessment";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { canonicalJson } from "~/server/lib/canonical-json";

async function photoReviewEvidence(db: Database, imageIds: string[]) {
  const imageEvidence = await loadImageAnalysisEvidence(db, imageIds);
  return imageIds.map((imageId) => ({
    imageId,
    recognizedText:
      imageEvidence.summaries.get(imageId)?.recognizedText ?? null,
    description: imageEvidence.descriptionEvidence.get(imageId) ?? null,
  }));
}

export async function photoBrandCreateInputFingerprint(
  db: Database,
  productId: string,
  imageIds: string[],
) {
  const id = await resolveOrThrow(db, "product", productId);
  return sha256Hex(
    canonicalJson({
      product: await fieldInputFingerprint(db, "product", id, "brandId"),
      photos: await photoReviewEvidence(db, imageIds),
    }),
  );
}

/** Photo drafts use the shared immutable review history without entering automatic application. */
export async function photoProductSuggestions(
  db: Database,
  input: {
    runId: string;
    groupKey: string;
    productId: string;
    review: PhotoGroupReview;
    imageIds: string[];
    retained?: PhotoGroupReview["fieldSuggestions"];
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
  const photoEvidence = await photoReviewEvidence(db, input.imageIds);
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
    const retained = input.retained?.find(
      (candidate) =>
        candidate.field === field &&
        canonicalJson(candidate.value) === canonicalJson(value),
    );
    if (retained) {
      suggestions.push(retained);
      continue;
    }
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
        decisionRevision: input.review.fieldDecisionRevisions?.[field] ?? null,
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
          memberDecisionRevision:
            input.review.fieldDecisionRevisions?.[field] ?? null,
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

/** Validate the captured proposal before any approval write; saved-field receipts only validate the result. */
export async function assertPhotoProductReviewCurrent(
  db: Database,
  productId: string,
  review: PhotoGroupReview,
  imageIds: string[],
) {
  const photoEvidence = await photoReviewEvidence(db, imageIds);
  const id = await resolveOrThrow(db, "product", productId);
  for (const [field, value] of Object.entries(review.productChanges ?? {})) {
    if (
      value === undefined ||
      field === "brandCreate" ||
      (field === "brandId" && review.productChanges?.brandCreate)
    )
      continue;
    const retained = review.fieldSuggestions?.find(
      (candidate) =>
        candidate.field === field &&
        canonicalJson(candidate.value) === canonicalJson(value),
    );
    if (!retained)
      throw new Error(
        "Product correction has no retained review evidence; save the draft again before approval",
      );
    const [saved] = await getDb(db)
      .select({ prediction: assessment, status: assessmentState.status })
      .from(assessment)
      .innerJoin(assessmentState, eq(assessmentState.id, assessment.id))
      .where(eq(assessment.id, retained.id))
      .for("update");
    if (!saved || saved.prediction.family !== "field")
      throw new Error(
        "A selected Product correction was already reviewed; revise the photo draft before approval",
      );
    const subject = assessmentSubjects.field.parse(saved.prediction.subject);
    const judgment = assessmentJudgments.field.parse(saved.prediction.judgment);
    if (
      subject.entity !== "product" ||
      subject.recordId !== id ||
      subject.field !== field ||
      canonicalJson(judgment.value) !== canonicalJson(value)
    )
      throw new Error(
        "Saved Product correction differs from its retained Assessment",
      );
    if (
      saved.prediction.fingerprint !==
      (await fieldInputFingerprint(db, "product", id, field, { lock: true }))
    )
      throw new Error(
        "Product correction inputs changed; clear and reselect the proposed field after reviewing the current Product",
      );
    const evidence = z
      .object({ photoEvidence: z.json() })
      .safeParse(saved.prediction.evidence);
    if (
      !evidence.success ||
      canonicalJson(evidence.data.photoEvidence) !==
        canonicalJson(photoEvidence)
    )
      throw new Error(
        "Photo correction inputs changed; clear and reselect the proposed field after reviewing current image evidence",
      );
    if (saved.status !== "pending")
      throw new Error(
        "A selected Product correction was already reviewed; revise the photo draft before approval",
      );
  }
  if (
    review.productChanges?.brandCreate &&
    review.brandCreateInputFingerprint !==
      (await sha256Hex(
        canonicalJson({
          product: await fieldInputFingerprint(db, "product", id, "brandId", {
            lock: true,
          }),
          photos: photoEvidence,
        }),
      ))
  )
    throw new Error(
      "Product Brand inputs changed; clear and reenter the new Brand after reviewing the Product and photo evidence",
    );
}
