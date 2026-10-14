import { assessmentFamily } from "@cubby/schemas/assessment";
import { entitySchema } from "@cubby/schemas/entity-core";
import type { ProductId } from "@cubby/schemas/identifiers";
import { productImagePurpose } from "@cubby/schemas/image";
import { type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/repo/database-helpers/core";

/** Read retained original-image evidence only; browsing never schedules vision. */
export const productClassificationEvidenceSql = (
  productId: SQL,
) => sql<string>`concat(
  'Taxonomy revision: ', (SELECT md5(string_agg(json_build_array(c."id", c."name", c."aliases", c."description", c."parentId", c."sortOrder", c."feature", c."deletedAt")::text, E'\n' ORDER BY c."id")) FROM "ProductCategory" c),
  E'\n', COALESCE((
    SELECT string_agg(concat(COALESCE(pi."purpose", ${productImagePurpose.enum.item}), ': ',
      COALESCE(correction."description", analysis."result"->>'description', ''),
      CASE WHEN correction."description" IS NOT NULL THEN ' [confirmed correction]' ELSE '' END), E'\n' ORDER BY pi."sortOrder", pi."createdAt")
    FROM "EntityAttachment" pi JOIN "Image" i ON i."id" = pi."imageId" AND i."deletedAt" IS NULL
    LEFT JOIN LATERAL (SELECT c."confirmedValue"->>'value' AS description FROM "AssessmentState" c WHERE c."recordId" = i."id" AND c.family = ${assessmentFamily.enum.image_description} AND c.active AND c."confirmedValue" @> ${JSON.stringify({ present: true })}::jsonb ORDER BY c."createdAt" DESC LIMIT 1) correction ON true
    LEFT JOIN LATERAL (SELECT a."result" FROM "AiAnalysis" a WHERE a."entityKind" = ${entitySchema.enum.image} AND a."entityId" = i."id" AND a."feature" = 'image-description' AND a."deletedAt" IS NULL ORDER BY a."createdAt" DESC LIMIT 1) analysis ON true
    WHERE pi."entityId" = ${productId} AND pi."deletedAt" IS NULL
  ), '')
)`;

export const getProductClassificationEvidence = async (
  db: Database | DrizzleTransaction,
  id: ProductId,
): Promise<string> => {
  const rows = await unwrapDb(db).execute<{ evidence: string }>(
    sql`SELECT ${productClassificationEvidenceSql(sql`${id}::uuid`)} AS evidence`,
  );
  return rows.rows[0]?.evidence ?? "";
};
