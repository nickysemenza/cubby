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
  return (await productIdentityEvidenceFences(db, [ids]))[0]!;
}

/** Preserve a separate read-set hash per pair while sharing the database round trip. */
export async function productIdentityEvidenceFences(
  db: Database,
  pairs: readonly (readonly [ProductId] | readonly [ProductId, ProductId])[],
): Promise<string[]> {
  if (!pairs.length) return [];
  const requested = sql.join(
    pairs.map((ids, index) => {
      const [first, second] =
        ids.length === 2 && ids[0] > ids[1] ? [ids[1], ids[0]] : ids;
      return sql`(${index}::int, ${first}::uuid, ${second ?? null}::uuid)`;
    }),
    sql`, `,
  );
  const result = await getDb(db).execute(sql`
    WITH requested(ordinal, first, second) AS (VALUES ${requested}),
    members AS (
      SELECT ordinal, unnest(array_remove(ARRAY[first, second]::uuid[], NULL)) AS id FROM requested
    ), targets AS (SELECT DISTINCT id FROM members),
    photos AS (
      SELECT "entityId" AS "productId", "imageId" AS id FROM "EntityAttachment"
      WHERE "entityKind" = ${entitySchema.enum.product} AND "entityId" IN (SELECT id FROM targets)
    ), bindings AS (
      SELECT t.id AS "targetId", b.* FROM "ImportSourceProduct" b
      LEFT JOIN "Expense" e ON e.id = b."expenseId"
      JOIN targets t ON b."productId" = t.id OR e."productId" = t.id
    ), orders AS (
      SELECT DISTINCT b."targetId", o.* FROM "ImportSourceOrder" o
      JOIN bindings b ON b."sourceOrderId" = o.id
    ), history AS (
      SELECT r.ordinal, a.id, a.evidence FROM "Assessment" a
      LEFT JOIN "AssessmentState" s ON s.id = a.id
      JOIN requested r ON (
        (a.subject->>'recordId' = r.first::text AND a.subject->>'otherId' = r.second::text)
        OR (s."recordId" = r.first AND s.data->>'otherId' = r.second::text)
      )
      WHERE a.family = ${assessmentFamily.enum.product_pair}
    ), product_versions AS (
      SELECT id AS "targetId", 'identity-product' AS kind, id::text, xmin::text AS version FROM "Product" WHERE id IN (SELECT id FROM targets)
      UNION ALL SELECT "entityId", 'external-id', id::text, xmin::text FROM "EntityExternalId" WHERE "entityKind" = ${entitySchema.enum.product} AND "entityId" IN (SELECT id FROM targets)
      UNION ALL SELECT "entityId", 'identity-attachment', id::text, xmin::text FROM "EntityAttachment" WHERE "entityKind" = ${entitySchema.enum.product} AND "entityId" IN (SELECT id FROM targets)
      UNION ALL SELECT p."productId", 'identity-image', i.id::text, i.xmin::text FROM "Image" i JOIN photos p ON p.id = i.id
      UNION ALL SELECT p."productId", 'identity-analysis', a.id::text, a.xmin::text FROM "AiAnalysis" a JOIN photos p ON p.id = a."entityId" WHERE a."entityKind" = ${entitySchema.enum.image}
      UNION ALL SELECT p."productId", 'state', s.id::text, s.xmin::text FROM "AssessmentState" s JOIN photos p ON p.id = s."recordId"
      UNION ALL SELECT b."targetId", 'binding', b.id::text, original.xmin::text FROM bindings b JOIN "ImportSourceProduct" original ON original.id = b.id
      UNION ALL SELECT t.id, 'identity-expense', e.id::text, e.xmin::text FROM "Expense" e JOIN targets t ON e."productId" = t.id OR e.id IN (SELECT "expenseId" FROM bindings WHERE "targetId" = t.id)
      UNION ALL SELECT o."targetId", 'order', o.id::text, original.xmin::text FROM orders o JOIN "ImportSourceOrder" original ON original.id = o.id
      UNION ALL SELECT o."targetId", 'claim', c.id::text, c.xmin::text FROM "ImportSourceClaim" c JOIN orders o ON o."sourceClaimId" = c.id
      UNION ALL SELECT t.id, 'identity-purchase-link', l.id::text, l.xmin::text FROM "EntityLink" l JOIN targets t ON l."toEntityId" = t.id OR l."fromEntityId" IN (SELECT "purchaseId" FROM orders WHERE "targetId" = t.id) WHERE l.kind = ${"purchaseProduct"}
      UNION ALL SELECT o."targetId", 'identity-purchase', p.id::text, p.xmin::text FROM "Purchase" p JOIN orders o ON o."purchaseId" = p.id
    ), shared_versions AS (
      SELECT 'identity-vendor' AS kind, id::text, xmin::text AS version FROM "Vendor"
      UNION ALL SELECT 'issuer', slug, xmin::text FROM "ExternalSource"
      UNION ALL SELECT 'activation', id::text, xmin::text FROM "AppSettings" WHERE id = ${AI_REFRESH_ACTIVATION_SETTINGS_ID}
    ), versions AS (
      SELECT m.ordinal, v.kind, v.id, v.version FROM product_versions v JOIN members m ON m.id = v."targetId"
      UNION ALL SELECT r.ordinal, v.kind, v.id, v.version FROM shared_versions v CROSS JOIN requested r
      UNION ALL SELECT h.ordinal, 'state', s.id::text, s.xmin::text FROM "AssessmentState" s JOIN history h ON h.id = s.id
      UNION ALL SELECT h.ordinal, 'identity-assessment', a.id::text, a.xmin::text FROM "Assessment" a JOIN history h ON a.id = h.id OR a.id::text IN (
        SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(h.evidence->'signals'->'conflictLineage') = 'array' THEN h.evidence->'signals'->'conflictLineage' ELSE '[]'::jsonb END)
      )
    ), unique_versions AS (
      SELECT DISTINCT ordinal, kind, id, version FROM versions
    )
    SELECT md5(coalesce(jsonb_agg(jsonb_build_array(v.kind, v.id, v.version) ORDER BY v.kind, v.id)
      FILTER (WHERE v.kind IS NOT NULL)::text, '[]')) AS fence
    FROM requested r LEFT JOIN unique_versions v ON v.ordinal = r.ordinal
    GROUP BY r.ordinal ORDER BY r.ordinal
  `);
  return z
    .object({ rows: z.array(z.object({ fence: z.string() })) })
    .parse(result)
    .rows.map((row) => row.fence);
}
