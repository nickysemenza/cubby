import {
  fieldProvenance,
  fieldEmptyReason,
} from "@cubby/schemas/field-envelope";
import { productCost } from "@cubby/schemas/product-fields";
import { and, isNull, sql } from "drizzle-orm";
/**
 * Product's stored derived values (ADR 0021): the effective price and the
 * ledger quantities, each the same SQL the list once evaluated per page.
 */
import { alias } from "drizzle-orm/pg-core";

import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { actualExpenseSql, notDeleted } from "~/server/db/helpers/predicates";
import { outer, quotedTable } from "~/server/db/helpers/related";
import { product, expense } from "~/server/db/schema";
import { productOwnershipCompute } from "~/server/domains/inventory/repo/derived";
import { serviceProductSqlText } from "~/server/domains/product/repo/service-category";
import type {
  DerivedCompute,
  DerivedComputed,
} from "~/server/generic/derived/repo/compute";
import { sqlColumnCompute } from "~/server/generic/derived/repo/sql-compute";

import { effectiveProductPriceSql } from "./pricing";
import { expectedQuantitySql, quantityVarianceSql } from "./quantity-ledger";

const row = quotedTable(product);
const charge = alias(expense, "e");
const source = { table: product, id: product.id, deletedAt: product.deletedAt };

/** Only services publish Cost; physical Cost projects the selected price read. */
const computeServiceCost: DerivedCompute = async (db, ids) => {
  const rows = await unwrapDb(db)
    .select({
      id: product.id,
      value: sql`(SELECT CASE WHEN count(*) > 0 THEN jsonb_build_object(
      ${productCost.options[1].keyof().enum.kind}::text, ${productCost.options[1].shape.kind.value}::text,
      'amount', round(avg(e."cost")::numeric, 2)::double precision,
      'chargeCount', count(*)::int,
      'chargeTotal', sum(e."cost"::double precision),
      'latestCharge', (array_agg(e."cost" ORDER BY e."date" DESC, e."id" DESC)
        FILTER (WHERE e."date" IS NOT NULL))[1]::double precision) END
      FROM "Expense" e WHERE e."productId" = ${outer(product.id)}
        AND ${notDeleted(charge)} AND ${sql.raw(actualExpenseSql("e"))} AND e."cost" > 0)`,
    })
    .from(product)
    .where(
      and(
        sql`${product.id} = ANY(${uuidArrayParam(ids)})`,
        isNull(product.deletedAt),
        sql.raw(serviceProductSqlText(`${row}."id"`)),
      ),
    );
  const out = new Map<string, DerivedComputed>();
  for (const result of rows) {
    const value = productCost.nullable().parse(result.value);
    out.set(String(result.id), { value, sort: value?.amount ?? null });
  }
  return out;
};

export const productDerivedComputes = {
  "product.ownership": productOwnershipCompute,
  "product.cost": computeServiceCost,
  "product.price": sqlColumnCompute(
    source,
    sql.raw(`(${effectiveProductPriceSql(row)})::double precision`),
    {
      emptyReason: sql`CASE WHEN ${sql.raw(serviceProductSqlText(`${row}."id"`))} THEN ${fieldEmptyReason.enum.not_applicable}::text ELSE ${fieldEmptyReason.enum.unset}::text END`,
      provenance: sql`CASE WHEN ${product.price} IS NOT NULL AND NOT ${sql.raw(serviceProductSqlText(`${row}."id"`))}
        THEN ${JSON.stringify(fieldProvenance.parse({ kind: "own", ownership: { kind: "record" } }))}::jsonb
        ELSE ${JSON.stringify(fieldProvenance.parse({ kind: "computed" }))}::jsonb END`,
    },
  ),
  "product.ledgerExpectedQuantity": sqlColumnCompute(
    source,
    sql.raw(`(${expectedQuantitySql(row)})::double precision`),
  ),
  "product.quantityVariance": sqlColumnCompute(
    source,
    sql.raw(`(${quantityVarianceSql(row)})::double precision`),
  ),
};
