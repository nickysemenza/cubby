import { z } from "zod";
import { productShortcode } from "./identifier-fields";

export const IMAGE_IDENTIFICATION_MODEL = "@cf/cloudflare/clef";
export const IMAGE_IDENTIFICATION_PROMPT_REVISION = 2;
export const IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION = 2;

export const imageIdentificationResult = z.object({
  subject: z.enum([
    "single_object",
    "multiple_objects",
    "document",
    "scene",
    "unclear",
  ]),
  identityScope: z
    .enum(["single_identity", "multiple_identities", "unclear"])
    .default("unclear"),
  category: z.string().nullable(),
  outcome: z.enum([
    "suggestions",
    "no_match",
    "not_single_identity",
    "no_candidates",
  ]),
  candidates: z
    .array(
      z.object({
        productId: productShortcode,
        name: z.string(),
        probability: z.number().min(0).max(1),
      }),
    )
    .max(3),
  considered: z.int().nonnegative(),
  truncated: z.boolean(),
});
export type ImageIdentificationResult = z.infer<
  typeof imageIdentificationResult
>;

/**
 * Condensed on-device/cloud analysis for one Image: top classifications, OCR
 * text, cloud description, and retained unconfirmed Product identification,
 * so an agent can decide whether to view the full image. This declaration-safe owner avoids importing the canonical Image module into entity definitions.
 * `null` means no analysis exists yet for the image; a present object's own
 * fields are independently nullable/empty depending on which analyses ran.
 */
export const imageAnalysisSummarySchema = z.object({
  description: z.string().nullable(),
  classifications: z.array(z.string()),
  recognizedText: z.string().nullable(),
  /** Suggestions are observations; identity and inventory still require confirmation. */
  identification: imageIdentificationResult.optional(),
});
export type ImageAnalysisSummary = z.infer<typeof imageAnalysisSummarySchema>;
