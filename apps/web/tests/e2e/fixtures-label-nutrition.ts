import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { entityAttachment, image, product } from "~/server/db/schema";
import { preferredImageDescriptionPolicy } from "~/server/image-processing/description-policy";
import { getDb } from "~/server/repo/database-helpers";
import { saveImageDescriptionAnalysis } from "~/server/repo/image-processing";
import {
  normalizeImageDescriptionResult,
  imageDescriptionInputFingerprint,
} from "~/server/services/image-description.service";
import { verifyProductImages } from "~/server/services/image-verification.service";
import { getFixtureDb } from "./fixtures-core";

/** Synthetic provider output injected at the external AI seam; upload/review/save remain real. */
export async function seedDetectedLabelNutrition(productName: string) {
  const db = getFixtureDb();
  const [target] = await getDb(db)
    .select({ id: product.id })
    .from(product)
    .where(eq(product.name, productName));
  if (!target) throw new Error("Synthetic label Product was not created");
  const verification = await verifyProductImages(
    db,
    parseEntityId("product", target.id),
  );
  if (
    verification.length !== 1 ||
    verification[0]?.storageStatus !== "available"
  )
    throw new Error("Uploaded synthetic label failed stored-byte verification");
  const [source] = await getDb(db)
    .select({
      id: image.id,
      shortcode: image.shortcode,
      hash: image.sha256,
      contentType: image.contentType,
    })
    .from(product)
    .innerJoin(
      entityAttachment,
      and(
        eq(entityAttachment.entityId, product.id),
        eq(entityAttachment.purpose, "label"),
      ),
    )
    .innerJoin(image, eq(image.id, entityAttachment.imageId))
    .where(eq(product.name, productName));
  if (!source?.hash)
    throw new Error("Uploaded synthetic label needs its verified hash");
  const policy = preferredImageDescriptionPolicy;
  await saveImageDescriptionAnalysis(db, {
    imageId: parseEntityId("image", source.id),
    provider: policy.provider,
    model: policy.model,
    promptRevision: policy.promptRevision,
    resultSchemaRevision: policy.resultSchemaRevision,
    inputFingerprint: imageDescriptionInputFingerprint({
      sourceContentHash: source.hash,
      contentType: source.contentType,
      provider: policy.provider,
      model: policy.model,
    }),
    result: normalizeImageDescriptionResult(
      {
        description: "A synthetic package Nutrition Facts panel",
        cutoutEligibility: "ineligible",
        claims: [
          {
            text: "Not a significant source of total fat.",
            evidenceKind: "ocr",
          },
        ],
        nutritionFacts: {
          servingGrams: 40,
          nutrients: { kcal: 120, protein: 4, sodium: 0 },
          inferredZeroNutrients: ["fat"],
          inferenceEvidence: "Not a significant source of total fat.",
        },
      },
      source.shortcode,
    ),
  });
  return source.shortcode;
}

export async function readStoredLabelNutrition(productName: string) {
  const [row] = await getDb(getFixtureDb())
    .select({ value: product.labelNutrition })
    .from(product)
    .where(eq(product.name, productName));
  return row?.value;
}
