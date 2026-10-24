import { entitySchema } from "@cubby/schemas/entity-core";
import type { ProductId } from "@cubby/schemas/identifiers";
import { productImagePurpose } from "@cubby/schemas/image";
import { type SQL, sql } from "drizzle-orm";

import { currentImageDescriptionConfirmation } from "~/server/db/computed/image-description-confirmation";
import {
  repositoryQueries as unwrapDb,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";

/** Read retained original-image evidence only; browsing never schedules vision. */
export const productClassificationEvidenceSql = (
  productId: SQL,
) => sql<string>`concat(
  'Taxonomy basis: ', (SELECT md5(coalesce(jsonb_agg(
    to_jsonb(c)-ARRAY['createdAt','updatedAt','deletedAt'] ORDER BY c.id
  ),'[]'::jsonb)::text) FROM "ProductCategory" c WHERE c."deletedAt" IS NULL),
  E'\n', COALESCE((
    SELECT string_agg(concat(COALESCE(pi."purpose", ${productImagePurpose.enum.item}), ': ',
      COALESCE(correction."description", analysis."result"->>'description', ''),
      CASE WHEN correction."description" IS NOT NULL THEN ' [confirmed correction]' ELSE '' END), E'\n' ORDER BY pi."sortOrder", pi."createdAt")
    FROM "EntityAttachment" pi JOIN "Image" ON "Image"."id" = pi."imageId" AND "Image"."deletedAt" IS NULL
    LEFT JOIN LATERAL (SELECT "AssessmentState"."confirmedValue"->>'value' AS description FROM "AssessmentState" JOIN "Assessment" ON "Assessment".id = "AssessmentState".id WHERE "AssessmentState"."recordId" = "Image"."id" AND ${currentImageDescriptionConfirmation()} ORDER BY "AssessmentState"."createdAt" DESC LIMIT 1) correction ON true
    LEFT JOIN LATERAL (SELECT a."result" FROM "AiAnalysis" a WHERE a."entityKind" = ${entitySchema.enum.image} AND a."entityId" = "Image"."id" AND a."feature" = 'image-description' AND a."deletedAt" IS NULL AND CASE WHEN pg_input_is_valid(a."inputFingerprint", ${"jsonb"}) THEN a."inputFingerprint"::jsonb->>'sourceContentHash' ELSE NULL END = "Image".sha256 ORDER BY a."createdAt" DESC LIMIT 1) analysis ON true
    WHERE pi."entityId" = ${productId} AND pi."deletedAt" IS NULL
  ), '')
)`;

export const getProductClassificationEvidence = async (
  db: RepositoryQueryInput,
  id: ProductId,
): Promise<string> => {
  const rows = await unwrapDb(db).execute<{ evidence: string }>(
    sql`SELECT ${productClassificationEvidenceSql(sql`${id}::uuid`)} AS evidence`,
  );
  return rows.rows[0]?.evidence ?? "";
};
