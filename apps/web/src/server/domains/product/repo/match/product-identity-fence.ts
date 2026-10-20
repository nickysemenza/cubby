import { assessmentFamily } from "@cubby/schemas/assessment";
import { entitySchema } from "@cubby/schemas/entity";
import type { ProductId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { AI_REFRESH_ACTIVATION_SETTINGS_ID } from "~/server/db/retained-tables";

/** Transient MVCC read-set fence, including absent rows through set membership.
 * Bracket preparation outside a transaction, then compare in the SERIALIZABLE
 * write transaction. Inserts, updates and deletes all invalidate the fence.
 * Keep this read set aligned with productIdentitySnapshot, identifier claims,
 * selected image descriptions and variant verification (including its active
 * producing manifest). Activation is read without a row lock here.
 * includes-deleted: tombstones/absent-row membership must also invalidate prep.
 * Issuer registries are deliberately conservative: any registry edit retries
 * preparation rather than allowing an unseen host owner to change a claim.
 */
export async function productIdentityEvidenceFence(
  db: Database,
  ids: readonly [ProductId] | readonly [ProductId, ProductId],
) {
  const [first, second] =
    ids.length === 2 && ids[0] > ids[1] ? [ids[1], ids[0]] : ids;
  const pairHistory = second
    ? sql`(
    (a.subject->>'recordId' = ${first} AND a.subject->>'otherId' = ${second})
    OR (s."recordId" = ${first} AND s.data->>'otherId' = ${second})
  )`
    : sql`false`;
  const productIds = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = await getDb(db).execute(sql`
    WITH targets AS (SELECT unnest(ARRAY[${productIds}]::uuid[]) AS id),
    photos AS (
      SELECT "imageId" AS id FROM "EntityAttachment"
      WHERE "entityKind" = ${entitySchema.enum.product} AND "entityId" IN (SELECT id FROM targets)
    ), bindings AS (
      SELECT * FROM "ImportSourceProduct" WHERE "productId" IN (SELECT id FROM targets)
    ), orders AS (
      SELECT * FROM "ImportSourceOrder" WHERE id IN (SELECT "sourceOrderId" FROM bindings)
    ), history AS (
      SELECT a.id, a.evidence FROM "Assessment" a
      LEFT JOIN "AssessmentState" s ON s.id = a.id
      WHERE a.family = ${assessmentFamily.enum.product_pair} AND ${pairHistory}
    ), versions AS (
      SELECT 'identity-product' AS kind, id::text, xmin::text AS version FROM "Product" WHERE id IN (SELECT id FROM targets)
      UNION ALL SELECT 'external-id', id::text, xmin::text FROM "EntityExternalId" WHERE "entityKind" = ${entitySchema.enum.product} AND "entityId" IN (SELECT id FROM targets)
      UNION ALL SELECT 'identity-source', id::text, xmin::text FROM "EntitySource" WHERE "entityKind" = ${entitySchema.enum.product} AND "entityId" IN (SELECT id FROM targets)
      UNION ALL SELECT 'identity-attachment', id::text, xmin::text FROM "EntityAttachment" WHERE "entityKind" = ${entitySchema.enum.product} AND "entityId" IN (SELECT id FROM targets)
      UNION ALL SELECT 'identity-image', id::text, xmin::text FROM "Image" WHERE id IN (SELECT id FROM photos)
      UNION ALL SELECT 'identity-analysis', id::text, xmin::text FROM "AiAnalysis" WHERE "entityKind" = ${entitySchema.enum.image} AND "entityId" IN (SELECT id FROM photos)
      UNION ALL SELECT 'state', id::text, xmin::text FROM "AssessmentState" WHERE id IN (SELECT id FROM history) OR "recordId" IN (SELECT id FROM photos)
      UNION ALL SELECT 'identity-assessment', id::text, xmin::text FROM "Assessment" WHERE id IN (SELECT id FROM history) OR id::text IN (
        SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(evidence->'signals'->'conflictLineage') = 'array' THEN evidence->'signals'->'conflictLineage' ELSE '[]'::jsonb END) FROM history
      )
      UNION ALL SELECT 'binding', id::text, xmin::text FROM "ImportSourceProduct" WHERE "productId" IN (SELECT id FROM targets)
      UNION ALL SELECT 'order', id::text, xmin::text FROM "ImportSourceOrder" WHERE id IN (SELECT id FROM orders)
      UNION ALL SELECT 'claim', id::text, xmin::text FROM "ImportSourceClaim" WHERE id IN (SELECT "sourceClaimId" FROM orders)
      UNION ALL SELECT 'identity-purchase', id::text, xmin::text FROM "Purchase" WHERE id IN (SELECT "purchaseId" FROM orders)
      UNION ALL SELECT 'identity-vendor', id::text, xmin::text FROM "Vendor"
      UNION ALL SELECT 'issuer', slug, xmin::text FROM "ExternalSource"
      UNION ALL SELECT 'activation', id::text, xmin::text FROM "AppSettings" WHERE id = ${AI_REFRESH_ACTIVATION_SETTINGS_ID}
    )
    SELECT md5(coalesce(jsonb_agg(jsonb_build_array(kind, id, version) ORDER BY kind, id)::text, '[]')) AS fence FROM versions
  `);
  return z
    .object({ rows: z.tuple([z.object({ fence: z.string() })]) })
    .parse(result).rows[0].fence;
}
