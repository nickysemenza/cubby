import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import { z } from "zod";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { providerFor } from "~/server/ai/models";

/** Changing this requires a fresh cloud-description job and analysis cache key. */
export const IMAGE_ANALYSIS_NORMALIZATION_REVISION = 1;

export const preferredImageDescriptionPolicy = {
  provider: providerFor(IMAGE_DESCRIPTION_FEATURE.model),
  model: IMAGE_DESCRIPTION_FEATURE.model,
  promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
  resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
  normalizationRevision: IMAGE_ANALYSIS_NORMALIZATION_REVISION,
} as const;

const imageDescriptionInputFingerprintSchema = z
  .object({
    feature: z.literal(IMAGE_DESCRIPTION_FEATURE.feature),
    renditionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sourceContentHash: z.string().min(1),
    contentType: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptRevision: z.number().int().positive(),
    resultSchemaRevision: z.number().int().positive(),
    normalizationRevision: z.number().int().positive(),
  })
  .strict();

export type ImageDescriptionInputFingerprint = z.infer<
  typeof imageDescriptionInputFingerprintSchema
>;

export function parseImageDescriptionInputFingerprint(
  value: string,
): ImageDescriptionInputFingerprint | null {
  try {
    const parsed = imageDescriptionInputFingerprintSchema.safeParse(
      JSON.parse(value),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function isCurrentPreferredImageDescription(
  fingerprint: ImageDescriptionInputFingerprint,
  input: {
    sourceContentHash: string | null;
    provider: string | null;
    model: string | null;
    promptRevision: number;
    resultSchemaRevision: number | null;
  },
): boolean {
  return (
    fingerprint.sourceContentHash === input.sourceContentHash &&
    input.provider === preferredImageDescriptionPolicy.provider &&
    input.model === preferredImageDescriptionPolicy.model &&
    input.promptRevision === preferredImageDescriptionPolicy.promptRevision &&
    input.resultSchemaRevision ===
      preferredImageDescriptionPolicy.resultSchemaRevision &&
    fingerprint.provider === preferredImageDescriptionPolicy.provider &&
    fingerprint.model === preferredImageDescriptionPolicy.model &&
    fingerprint.promptRevision ===
      preferredImageDescriptionPolicy.promptRevision &&
    fingerprint.resultSchemaRevision ===
      preferredImageDescriptionPolicy.resultSchemaRevision &&
    fingerprint.normalizationRevision ===
      preferredImageDescriptionPolicy.normalizationRevision
  );
}
