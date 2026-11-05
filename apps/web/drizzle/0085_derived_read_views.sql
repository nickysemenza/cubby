SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE OR REPLACE VIEW "ProductCostView" AS SELECT p.id AS "entityId", 'product'::text AS kind,
  v.value, (v.value->>'amount')::double precision AS "sortNumber", NULL::text AS "sortText", NULL::timestamp AS "sortDate",
  CASE WHEN v.value IS NULL THEN '{"outcome":{"kind":"empty","reason":"unset"},"provenance":{"kind":"computed"}}'::jsonb
  ELSE '{"outcome":{"kind":"value"},"provenance":{"kind":"computed"}}'::jsonb END AS "decidedBy",
  (now() AT TIME ZONE 'UTC') AS "computedAt"
  FROM "Product" p JOIN "Entity" identity ON identity.id = p.id AND identity.kind = 'product'
  CROSS JOIN LATERAL (SELECT CASE WHEN count(*) > 0 THEN jsonb_build_object(
    'kind'::text, 'service_charge'::text,
    'amount', round(avg(e."cost")::numeric, 2)::double precision,
    'chargeCount', count(*)::int, 'chargeTotal', sum(e."cost"::double precision),
    'latestCharge', (array_agg(e."cost" ORDER BY e."date" DESC, e."id" DESC) FILTER (WHERE e."date" IS NOT NULL))[1]::double precision) END AS value
    FROM "Expense" e WHERE e."productId" = p.id AND "e"."deletedAt" is null AND e."future" = false AND e."cost" > 0) v
  WHERE "p"."deletedAt" is null AND "identity"."deletedAt" is null AND COALESCE((SELECT COALESCE("r1"."categoryId" IN (
    WITH RECURSIVE "ih0s" AS (
      SELECT "ih0n"."id", 0 AS ih_depth, ARRAY["ih0n"."id"] AS ih_visited
      FROM "ProductCategory" "ih0n"
      WHERE "ih0n"."feature" IS NOT NULL AND "ih0n"."feature" IN ('software', 'services') AND "ih0n"."deletedAt" IS NULL
      UNION ALL
      SELECT "ih0n"."id", "ih0s"."ih_depth" + 1, "ih0s"."ih_visited" || "ih0n"."id"
      FROM "ih0s" JOIN "ProductCategory" "ih0n" ON "ih0n"."parentId" = "ih0s"."id"
      WHERE NOT "ih0n"."feature" IS NOT NULL AND "ih0s"."ih_depth" < 2
        AND array_position("ih0s"."ih_visited", "ih0n"."id") IS NULL AND "ih0n"."deletedAt" IS NULL
    ) SELECT "id" FROM "ih0s"
  ), false) FROM "Product" "r1" WHERE ("r1"."id" = p.id) AND ("r1"."deletedAt" IS NULL) LIMIT 1), false);
