/**
 * Product's stored derived values (ADR 0021): the effective price and the
 * ledger quantities, each the same SQL the list once evaluated per page.
 */
import { sql } from "drizzle-orm";

import { quotedTable } from "~/server/db/helpers/related";
import { product } from "~/server/db/schema";
import { sqlColumnCompute } from "~/server/generic/derived/repo/sql-compute";

import { displayProductCostSql } from "./pricing";
import { expectedQuantitySql, quantityVarianceSql } from "./quantity-ledger";

const row = quotedTable(product);
const source = { table: product, id: product.id, deletedAt: product.deletedAt };

export const productDerivedComputes = {
  "product.price": sqlColumnCompute(
    source,
    sql.raw(`(${displayProductCostSql(row)})::double precision`),
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
