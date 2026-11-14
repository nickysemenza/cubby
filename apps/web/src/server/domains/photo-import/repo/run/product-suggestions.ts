import type { PhotoGroupReview } from "@cubby/schemas/photo-import-run";
import { sha256Hex } from "@cubby/shared/sha256";
import { z } from "zod";

import type { Database } from "~/server/db";
import { loadImageAnalysisEvidence } from "~/server/domains/image/repo/image-analysis-summary";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
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

/** A draft's review key covers its retained source evidence; approval records the field Decision. */
async function photoFieldKey(
  db: Database,
  productId: string,
  field: string,
  value: z.infer<ReturnType<typeof z.json>>,
  review: PhotoGroupReview,
  photoEvidence: Awaited<ReturnType<typeof photoReviewEvidence>>,
) {
  const fingerprint = await fieldInputFingerprint(
    db,
    "product",
    productId,
    field,
    { lock: true },
  );
  const hash = await sha256Hex(
    canonicalJson({
      productId,
      field,
      value,
      fingerprint,
      photoEvidence,
      observedName: review.observedName,
      decisionRevision: review.fieldDecisionRevisions?.[field] ?? null,
    }),
  );
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

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
  const id = await resolveOrThrow(db, "product", input.productId);
  const photos = await photoReviewEvidence(db, input.imageIds);
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
    suggestions.push(
      retained ?? {
        id: await photoFieldKey(db, id, field, value, input.review, photos),
        field,
        value,
      },
    );
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
    if (
      retained.id !==
      (await photoFieldKey(db, id, field, value, review, photoEvidence))
    )
      throw new Error(
        "Product or photo correction inputs changed; clear and reselect the proposed field after reviewing current evidence",
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
