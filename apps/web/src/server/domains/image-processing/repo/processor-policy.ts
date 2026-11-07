import {
  IMAGE_IDENTIFICATION_MODEL,
  IMAGE_IDENTIFICATION_PROMPT_REVISION,
  IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-identification";
import {
  imageProcessingJobKind,
  imageProcessingJobState,
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import { sql, type SQL } from "drizzle-orm";

import {
  currentPreferredCloudDescriptionSql,
  preferredImageDescriptionPolicy,
} from "./description-policy";

// Cloud eligibility no longer gates Apple subject lifting; prior skipped work can be rescheduled.
export const IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION = 2;

/**
 * Jobs are unique by an integer revision. Derive that revision from every
 * cloud-analysis input that changes the result so a model, provider, prompt,
 * schema, or rendition revision creates fresh work without touching cutouts.
 */
function stableProcessorRevision(identity: string): number {
  let hash = 0x811c9dc5;
  for (const character of identity) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2_000_000_000 || 1;
}

export const IMAGE_DESCRIPTION_PROCESSOR_REVISION = stableProcessorRevision(
  [
    "cloud",
    preferredImageDescriptionPolicy.provider,
    preferredImageDescriptionPolicy.model,
    preferredImageDescriptionPolicy.promptRevision,
    preferredImageDescriptionPolicy.resultSchemaRevision,
    `orientation-rendition-v${preferredImageDescriptionPolicy.normalizationRevision}`,
  ].join("/"),
);
/** Separate identity keeps opt-in Apple evaluations from replacing cloud work. */
export const IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION =
  stableProcessorRevision(
    [
      "apple",
      IMAGE_DESCRIPTION_PROMPT_REVISION,
      IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
      "actual-image-description-v1",
    ].join("/"),
  );

export const IMAGE_IDENTIFICATION_PROCESSOR_REVISION = stableProcessorRevision(
  [
    "cloud",
    IMAGE_IDENTIFICATION_MODEL,
    IMAGE_IDENTIFICATION_PROMPT_REVISION,
    IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
  ].join("/"),
);

/** A terminal guardrail refusal stops these Apple inputs; current cloud evidence satisfies automatic attention only. */
export function appleRefusalCoveredByCloudDescriptionSql(input: {
  jobAlias: string;
  imageId: SQL;
  sourceContentHash: SQL;
}): SQL<boolean> {
  const column = (name: string) =>
    sql`${sql.identifier(input.jobAlias)}.${sql.identifier(name)}`;
  return sql<boolean>`CASE WHEN ${column("kind")} = ${imageProcessingJobKind.enum.describe_image}
    AND ${column("processorRevision")} = ${IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION}
    AND ${column("state")} = ${imageProcessingJobState.enum.failed}
    AND starts_with(${column("lastError")}, 'guardrail_violation: ')
    AND ${column("imageId")} = ${input.imageId}
    AND ${column("sourceContentHash")} = ${input.sourceContentHash}
    THEN ${currentPreferredCloudDescriptionSql(input)} ELSE false END`;
}
