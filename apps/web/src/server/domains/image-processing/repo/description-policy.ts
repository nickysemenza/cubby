import { entitySchema } from "@cubby/schemas/entity-core";
import {
  IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
  IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import { providerFor } from "@cubby/shared/ai/models";
import { parseJsonAs } from "@cubby/shared/parse-json-as";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { IMAGE_DESCRIPTION_IDENTITY } from "~/server/ai/policy/feature-identity";
import { notDeleted } from "~/server/db/helpers/predicates";

/** Changing this requires a fresh cloud-description job and analysis cache key. */
export const IMAGE_ANALYSIS_NORMALIZATION_REVISION = 1;

/** Keep the stored key order stable: retained analyses match this exact string. */
export function imageDescriptionInputFingerprint(input: {
  sourceContentHash: string;
  contentType: string;
  model: string;
  provider: string;
  renditionHash?: string;
  promptRevision?: number;
  resultSchemaRevision?: number;
}): string {
  return JSON.stringify({
    renditionHash: input.renditionHash,
    feature: IMAGE_DESCRIPTION_IDENTITY.feature,
    sourceContentHash: input.sourceContentHash,
    contentType: input.contentType,
    provider: input.provider,
    model: input.model,
    promptRevision:
      input.promptRevision ?? IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
    resultSchemaRevision:
      input.resultSchemaRevision ??
      IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
    normalizationRevision: IMAGE_ANALYSIS_NORMALIZATION_REVISION,
  });
}

export const preferredImageDescriptionPolicy = {
  provider: providerFor(IMAGE_DESCRIPTION_IDENTITY.model),
  model: IMAGE_DESCRIPTION_IDENTITY.model,
  promptRevision: IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
  resultSchemaRevision: IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
  normalizationRevision: IMAGE_ANALYSIS_NORMALIZATION_REVISION,
} as const;

/** Keep this evidence fence aligned with the fingerprint parser and preferred selection below. */
export function currentPreferredCloudDescriptionSql(input: {
  imageId: SQL;
  sourceContentHash: SQL;
}): SQL<boolean> {
  const policy = preferredImageDescriptionPolicy;
  return sql<boolean>`EXISTS (
    SELECT 1 FROM "AiAnalysis" description_analysis
    CROSS JOIN LATERAL (SELECT CASE
      WHEN pg_input_is_valid(description_analysis."inputFingerprint", ${"jsonb"})
      THEN description_analysis."inputFingerprint"::jsonb ELSE NULL END AS value
    ) description_fingerprint
    WHERE ${notDeleted("description_analysis")}
      AND description_analysis."entityKind" = ${entitySchema.enum.image}
      AND description_analysis."entityId" = ${input.imageId}
      AND description_analysis.feature = ${IMAGE_DESCRIPTION_IDENTITY.feature}
      AND description_analysis.provider = ${policy.provider}
      AND description_analysis.model = ${policy.model}
      AND description_analysis."promptVersion" = ${String(policy.promptRevision)}
      AND description_analysis."resultSchemaRevision" = ${policy.resultSchemaRevision}
      AND jsonb_typeof(description_fingerprint.value) = 'object'
      AND description_fingerprint.value->>'feature' = ${IMAGE_DESCRIPTION_IDENTITY.feature}
      AND jsonb_typeof(description_fingerprint.value->'sourceContentHash') = 'string'
      AND description_fingerprint.value->>'sourceContentHash' = ${input.sourceContentHash}
      AND description_fingerprint.value->>${"provider"} = ${policy.provider}
      AND description_fingerprint.value->>${"model"} = ${policy.model}
      AND description_fingerprint.value->'promptRevision' = to_jsonb(${policy.promptRevision}::int)
      AND description_fingerprint.value->'resultSchemaRevision' = to_jsonb(${policy.resultSchemaRevision}::int)
      AND description_fingerprint.value->'normalizationRevision' = to_jsonb(${policy.normalizationRevision}::int)
      AND jsonb_typeof(description_fingerprint.value->'contentType') = 'string'
      AND length(description_fingerprint.value->>'contentType') > 0
      AND (NOT description_fingerprint.value ? 'renditionHash'
        OR (jsonb_typeof(description_fingerprint.value->'renditionHash') = 'string'
          AND description_fingerprint.value->>'renditionHash' ~ '^[a-f0-9]{64}$'))
      AND CASE WHEN jsonb_typeof(description_fingerprint.value) = 'object'
        THEN description_fingerprint.value - ARRAY['renditionHash', 'feature', 'sourceContentHash', 'contentType', ${"provider"}, ${"model"}, 'promptRevision', 'resultSchemaRevision', 'normalizationRevision'] = '{}'::jsonb
        ELSE false END
      AND jsonb_typeof(description_analysis.result->'description') = 'string'
      AND length(description_analysis.result->>'description') > 0
  )`;
}

const imageDescriptionInputFingerprintSchema = z
  .object({
    feature: z.literal(IMAGE_DESCRIPTION_IDENTITY.feature),
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
  return parseJsonAs(imageDescriptionInputFingerprintSchema, value) ?? null;
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
