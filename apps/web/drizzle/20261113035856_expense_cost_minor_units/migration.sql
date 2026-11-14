-- Store signed Expense costs as exact cents. Any original that is not a whole cent
-- within the predecessor check tolerance aborts for member review instead of rounding.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
LOCK TABLE public."Expense" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- The derived view reads the column whose type changes; it is recreated below.
DROP VIEW public."ProductCostView";
--> statement-breakpoint
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public."Expense"
    WHERE cost::text IN ('NaN','Infinity','-Infinity')
      OR abs(cost) > 1000000000000
      OR abs(cost * 100 - round(cost * 100)) >= 0.0000001
  ) THEN RAISE EXCEPTION 'Expense costs contain unproven whole-cent money; preserve them for review'; END IF;
  CREATE SCHEMA IF NOT EXISTS archive;
  CREATE TABLE archive."Expense_dollar_preimage" AS TABLE public."Expense";
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE contype='f' AND
      (conrelid='archive."Expense_dollar_preimage"'::regclass OR confrelid='archive."Expense_dollar_preimage"'::regclass)
    UNION ALL SELECT 1 FROM pg_trigger WHERE tgrelid='archive."Expense_dollar_preimage"'::regclass AND NOT tgisinternal
    UNION ALL SELECT 1 FROM pg_index WHERE indrelid='archive."Expense_dollar_preimage"'::regclass
  ) THEN RAISE EXCEPTION 'Archived Expense costs retain active relationships, triggers or indexes'; END IF;
  ALTER TABLE public."Expense" DROP CONSTRAINT "Expense_cost_whole_cent_check";
  ALTER TABLE public."Expense" RENAME COLUMN "cost" TO "costMinor";
  ALTER TABLE public."Expense" ALTER COLUMN "costMinor" SET DATA TYPE bigint
    USING round("costMinor" * 100)::bigint;
  -- Per row: same null, same sign, within the whole-cent tolerance (far inside half a
  -- cent), and every other field unchanged.
  IF EXISTS (
    SELECT 1 FROM archive."Expense_dollar_preimage" original
    FULL JOIN public."Expense" converted USING(id)
    WHERE original.id IS NULL OR converted.id IS NULL
      OR (original.cost IS NULL) <> (converted."costMinor" IS NULL)
      OR sign(original.cost) <> sign(converted."costMinor"::float8)
      OR abs(original.cost - converted."costMinor"::float8 / 100) >= 0.000001
      OR to_jsonb(original)-'cost' IS DISTINCT FROM to_jsonb(converted)-'costMinor'
  ) THEN RAISE EXCEPTION 'Expense costs failed per-row cent preservation'; END IF;
  -- Totals: the exact decimal sum of the originals equals the integer sum, overall and
  -- per Purchase and Project.
  IF EXISTS (
    SELECT 1 FROM archive."Expense_dollar_preimage" original
    JOIN public."Expense" converted USING(id)
    GROUP BY GROUPING SETS ((), (original."purchaseId"), (original."projectId"))
    HAVING coalesce(sum(original.cost::numeric), 0) * 100 <> coalesce(sum(converted."costMinor"), 0)
  ) THEN RAISE EXCEPTION 'Expense cost totals changed in cent conversion'; END IF;
END;
$migration$;
--> statement-breakpoint
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_cost_minor_range_check" CHECK ("costMinor" IS NULL OR abs("costMinor") <= 100000000000000);--> statement-breakpoint
ALTER TABLE "Expense" DROP CONSTRAINT "Expense_date_cost_check", ADD CONSTRAINT "Expense_date_cost_check" CHECK ("date" IS NOT NULL OR "costMinor" IS NULL OR "costMinor" = 0);--> statement-breakpoint
ALTER TABLE "Expense" DROP CONSTRAINT "Expense_productQuantity_check", ADD CONSTRAINT "Expense_productQuantity_check" CHECK ("productQuantity" IS NULL OR ("productId" IS NOT NULL AND ("productQuantity" <> 0 OR ("costMinor" IS NOT NULL AND "costMinor" < 0))));--> statement-breakpoint
CREATE OR REPLACE VIEW "ProductCostView" AS SELECT p.id AS "entityId", 'product'::text AS kind,
  v.value, (v.value->>'amount')::double precision AS "sortNumber", NULL::text AS "sortText", NULL::timestamp AS "sortDate",
  CASE WHEN v.value IS NULL THEN '{"outcome":{"kind":"empty","reason":"unset"},"provenance":{"kind":"computed"}}'::jsonb
  ELSE '{"outcome":{"kind":"value"},"provenance":{"kind":"computed"}}'::jsonb END AS "decidedBy",
  (now() AT TIME ZONE 'UTC') AS "computedAt"
  FROM "Product" p JOIN "Entity" identity ON identity.id = p.id AND identity.kind = 'product'
  CROSS JOIN LATERAL (SELECT CASE WHEN count(*) > 0 THEN jsonb_build_object(
    'kind'::text, 'service_charge'::text,
    'amount', round(avg(e."costMinor") / 100, 2)::double precision,
    'chargeCount', count(*)::int, 'chargeTotal', (sum(e."costMinor") / 100.0)::double precision,
    'latestCharge', ((array_agg(e."costMinor" ORDER BY e."date" DESC, e."id" DESC) FILTER (WHERE e."date" IS NOT NULL))[1] / 100.0)::double precision) END AS value
    FROM "Expense" e WHERE e."productId" = p.id AND ("e"."deletedAt" is null) AND e."future" = false AND e."costMinor" > 0) v
  WHERE ("p"."deletedAt" is null) AND ("identity"."deletedAt" is null) AND COALESCE((SELECT COALESCE("r1"."categoryId" IN (
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
