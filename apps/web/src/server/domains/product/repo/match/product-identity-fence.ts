import { entitySchema } from "@cubby/schemas/entity";
import type { ProductId } from "@cubby/schemas/identifiers";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { requestedRows } from "~/server/db/helpers/requested";

export type ProductIdentityFenceTarget = {
  key: string;
  productIds: readonly [ProductId] | readonly [ProductId, ProductId];
};

/** Keyed MVCC read-set fences, including absent membership and tombstones.
 * Bracket preparation on root handles and compare inside SERIALIZABLE publication.
 * Global issuer/activation evidence is read once and included in every digest;
 * unrelated Product edits do not invalidate a sibling's evidence.
 * includes-deleted: tombstones and absent-row membership invalidate preparation.
 */
export async function productIdentityEvidenceFences(
  db: Database,
  targets: readonly ProductIdentityFenceTarget[],
): Promise<Map<string, string>> {
  if (!targets.length) return new Map();
  const unique = new Map(targets.map((target) => [target.key, target]));
  const values = [...unique.values()].map(({ key, productIds }) => {
    const [first, second] = [...productIds].sort();
    return { key, first: first!, second: second ?? null };
  });
  const rows = requestedRows(
    values,
    { key: "text", first: "uuid", second: "uuid" },
    "target_rows",
  );
  const result = await getDb(db).execute(sql`
    WITH targets AS (SELECT * FROM ${rows.from}),
    target_products AS MATERIALIZED (
      SELECT key, first AS id FROM targets UNION SELECT key, second FROM targets WHERE second IS NOT NULL
    ), photos AS MATERIALIZED (
      SELECT t.key, a."imageId" AS id FROM target_products t JOIN "EntityAttachment" a ON a."entityId" = t.id
      WHERE a."entityKind" = ${entitySchema.enum.product}
    ), bindings AS MATERIALIZED (
      SELECT t.key, b.id, b."sourceOrderId", b."expenseId" FROM target_products t JOIN "ImportSourceProduct" b ON b."productId" = t.id
      UNION SELECT t.key, b.id, b."sourceOrderId", b."expenseId" FROM target_products t JOIN "Expense" e ON e."productId" = t.id JOIN "ImportSourceProduct" b ON b."expenseId" = e.id
    ), orders AS MATERIALIZED (
      SELECT DISTINCT b.key, o.id, o."sourceClaimId", o."purchaseId" FROM bindings b JOIN "ImportSourceOrder" o ON o.id = b."sourceOrderId"
    ), history AS MATERIALIZED (
      SELECT t.key, s.id, s.evidence FROM targets t JOIN "Suggestion" s ON s.family = ${suggestionFamily.enum.product_pair}
        AND s.subject->>'recordId' = t.first::text AND s.subject->>'otherId' = t.second::text
      WHERE t.second IS NOT NULL
      UNION SELECT t.key, s.id, s.evidence FROM targets t JOIN "Suggestion" s ON s."recordId" = t.first AND s.data->>'otherId' = t.second::text
        AND s.family = ${suggestionFamily.enum.product_pair} WHERE t.second IS NOT NULL
    ), history_ids AS MATERIALIZED (
      SELECT key, id::text AS id FROM history
      UNION SELECT key, jsonb_array_elements_text(CASE WHEN jsonb_typeof(evidence->'signals'->'conflictLineage') = 'array' THEN evidence->'signals'->'conflictLineage' ELSE '[]'::jsonb END) FROM history
    ), global_versions AS MATERIALIZED (
      SELECT 'identity-vendor' AS kind, id::text, xmin::text AS version FROM "Vendor"
      UNION ALL SELECT 'issuer', slug, xmin::text FROM "ExternalSource"
    ), global_digest AS (
      SELECT md5(coalesce(jsonb_agg(jsonb_build_array(kind, id, version) ORDER BY kind, id)::text, '[]')) AS digest FROM global_versions
    ), versions AS (
      SELECT t.key, 'identity-product' AS kind, p.id::text, p.xmin::text AS version FROM target_products t JOIN "Product" p ON p.id = t.id
      UNION ALL SELECT t.key, 'identity-brand', b.id::text, b.xmin::text FROM target_products t JOIN "Product" p ON p.id = t.id JOIN "Vendor" b ON b.id = p."brandId"
      UNION ALL SELECT t.key, 'external-id', e.id::text, e.xmin::text FROM target_products t JOIN "EntityExternalId" e ON e."entityId" = t.id WHERE e."entityKind" = ${entitySchema.enum.product}
      UNION ALL SELECT t.key, 'identity-attachment', a.id::text, a.xmin::text FROM target_products t JOIN "EntityAttachment" a ON a."entityId" = t.id WHERE a."entityKind" = ${entitySchema.enum.product}
      UNION ALL SELECT t.key, 'identity-image', i.id::text, i.xmin::text FROM photos t JOIN "Image" i ON i.id = t.id
      UNION ALL SELECT t.key, 'identity-analysis', a.id::text, a.xmin::text FROM photos t JOIN "AiAnalysis" a ON a."entityId" = t.id WHERE a."entityKind" = ${entitySchema.enum.image}
      UNION ALL SELECT h.key, 'state', s.id::text, s.xmin::text FROM history h JOIN "Suggestion" s ON s.id = h.id
      UNION ALL SELECT t.key, 'state', s.id::text, s.xmin::text FROM photos t JOIN "Suggestion" s ON s."recordId" = t.id
      -- Keep the exact text recheck: non-canonical lineage must not gain membership.
      UNION ALL SELECT h.key, 'identity-suggestion', s.id::text, s.xmin::text FROM history_ids h JOIN "Suggestion" s
        ON s.id = CASE WHEN pg_input_is_valid(h.id, ${"uuid"}) THEN h.id::uuid END AND s.id::text = h.id
      UNION ALL SELECT t.key, 'binding', b.id::text, b.xmin::text FROM bindings t JOIN "ImportSourceProduct" b ON b.id = t.id
      UNION ALL SELECT t.key, 'identity-expense', e.id::text, e.xmin::text FROM target_products t JOIN "Expense" e ON e."productId" = t.id
      UNION ALL SELECT t.key, 'identity-expense', e.id::text, e.xmin::text FROM bindings t JOIN "Expense" e ON e.id = t."expenseId"
      UNION ALL SELECT t.key, 'order', o.id::text, o.xmin::text FROM orders t JOIN "ImportSourceOrder" o ON o.id = t.id
      UNION ALL SELECT t.key, 'claim', c.id::text, c.xmin::text FROM orders t JOIN "ImportSourceClaim" c ON c.id = t."sourceClaimId"
      UNION ALL SELECT t.key, 'identity-purchase-link', l.id::text, l.xmin::text FROM target_products t JOIN "EntityLink" l ON l."toEntityId" = t.id WHERE l.kind = ${"purchaseProduct"}
      UNION ALL SELECT t.key, 'identity-purchase', p.id::text, p.xmin::text FROM orders t JOIN "Purchase" p ON p.id = t."purchaseId"
    ), local_digests AS (
      SELECT key, md5(jsonb_agg(jsonb_build_array(kind, id, version) ORDER BY kind, id)::text) AS digest
      FROM (SELECT DISTINCT * FROM versions) v GROUP BY key
    )
    SELECT t.key, md5(coalesce(l.digest, '[]') || g.digest) AS fence
    FROM targets t CROSS JOIN global_digest g LEFT JOIN local_digests l ON l.key = t.key
  `);
  return new Map(
    z
      .object({
        rows: z.array(z.object({ key: z.string(), fence: z.string() })),
      })
      .parse(result)
      .rows.map(({ key, fence }) => [key, fence]),
  );
}
