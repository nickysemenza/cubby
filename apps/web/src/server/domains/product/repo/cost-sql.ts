import { entitySchema } from "@cubby/schemas/entity";
import { productCost } from "@cubby/schemas/product-fields";
import { sql } from "drizzle-orm";

import { actualExpenseSql, notDeleted } from "~/server/db/helpers/predicates";

import { serviceProductSqlText } from "./service-category";

/** Same service-charge projection as the predecessor adapter, now evaluated by PostgreSQL. */
export const productCostViewSql = sql`SELECT p.id AS "entityId", ${entitySchema.enum.product}::text AS kind,
  v.value, (v.value->>'amount')::double precision AS "sortNumber", NULL::text AS "sortText", NULL::timestamp AS "sortDate",
  CASE WHEN v.value IS NULL THEN '{"outcome":{"kind":"empty","reason":"unset"},"provenance":{"kind":"computed"}}'::jsonb
  ELSE '{"outcome":{"kind":"value"},"provenance":{"kind":"computed"}}'::jsonb END AS "decidedBy",
  (now() AT TIME ZONE 'UTC') AS "computedAt"
  FROM "Product" p JOIN "Entity" identity ON identity.id = p.id AND identity.kind = ${entitySchema.enum.product}
  CROSS JOIN LATERAL (SELECT CASE WHEN count(*) > 0 THEN jsonb_build_object(
    ${productCost.options[1].keyof().enum.kind}::text, ${productCost.options[1].shape.kind.value}::text,
    'amount', round(avg(e."cost")::numeric, 2)::double precision,
    'chargeCount', count(*)::int, 'chargeTotal', sum(e."cost"::double precision),
    'latestCharge', (array_agg(e."cost" ORDER BY e."date" DESC, e."id" DESC) FILTER (WHERE e."date" IS NOT NULL))[1]::double precision) END AS value
    FROM "Expense" e WHERE e."productId" = p.id AND ${notDeleted("e")} AND ${sql.raw(actualExpenseSql("e"))} AND e."cost" > 0) v
  WHERE ${notDeleted("p")} AND ${notDeleted("identity")} AND ${sql.raw(serviceProductSqlText("p.id"))}`;
