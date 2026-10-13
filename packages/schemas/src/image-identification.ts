import { z } from "zod";
import { productShortcode } from "./identifier-fields";

export const IMAGE_IDENTIFICATION_MODEL = "@cf/cloudflare/clef";
export const IMAGE_IDENTIFICATION_PROMPT_REVISION = 1;
export const IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION = 1;

export const imageIdentificationResult = z.object({
  subject: z.enum([
    "single_object",
    "multiple_objects",
    "document",
    "scene",
    "unclear",
  ]),
  category: z.string().nullable(),
  outcome: z.enum([
    "suggestions",
    "no_match",
    "not_single_subject",
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
