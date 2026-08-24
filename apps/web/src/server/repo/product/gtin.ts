/**
 * Barcodes, as `ProductExternalId` rows.
 *
 * A product carries a SET of barcodes, not one: a manufacturer reissues a SKU,
 * a retailer relabels, two listings of one item disagree. `Product.upc` could
 * hold exactly one, so every merge of two barcoded products destroyed a real
 * identifier — this module is the replacement read/write surface.
 *
 * Values are canonical GTIN-14 (see `normalizeGtin`), so identity is plain
 * string equality and the global `(source, kind, externalId)` unique is what
 * guarantees at most one live owner per barcode.
 */

import {
  GTIN_KIND,
  GTIN_SOURCE,
  normalizeGtin,
} from "@cubby/schemas/external-id";
import type { ProductId } from "@cubby/schemas/identifiers";
import { productCodeSearchTerms } from "@cubby/schemas/isbn";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { product, productExternalId } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

const liveGtinRows = (db: Database, ids: ProductId[]) =>
  getDb(db)
    .select({
      productId: productExternalId.productId,
      externalId: productExternalId.externalId,
      isPrimary: productExternalId.isPrimary,
    })
    .from(productExternalId)
    .where(
      and(
        inArray(productExternalId.productId, ids),
        eq(productExternalId.source, GTIN_SOURCE),
        notDeleted(productExternalId),
      ),
    )
    .orderBy(
      sql`${productExternalId.isPrimary} DESC`,
      productExternalId.createdAt,
      productExternalId.id,
    );

/**
 * The one barcode that stands for each product, batched by id.
 *
 * Modelled on `loadProductDataQualities` / `getProductImagesByProductIds`
 * rather than a correlated subquery on purpose: drizzle strips table prefixes
 * from interpolated columns inside a `sql` SELECT field on a single-table
 * select, so a correlated scalar over `ProductExternalId` silently self-joins
 * and returns NULL with no error.
 */
export const loadPrimaryGtins = async (
  db: Database,
  ids: ProductId[],
): Promise<Map<ProductId, string | null>> => {
  const unique = [...new Set(ids)];
  const out = new Map<ProductId, string | null>(
    unique.map((id) => [id, null] as const),
  );
  if (unique.length === 0) return out;
  for (const row of await liveGtinRows(db, unique)) {
    if (out.get(row.productId) == null) out.set(row.productId, row.externalId);
  }
  return out;
};

/**
 * EVERY barcode per product, batched by id — for search keywords and embedding
 * text, where indexing only the primary would make a product's second barcode
 * unfindable by the very thing it exists to identify.
 */
export const loadAllGtins = async (
  db: Database,
  ids: ProductId[],
): Promise<Map<ProductId, string[]>> => {
  const unique = [...new Set(ids)];
  const out = new Map<ProductId, string[]>(
    unique.map((id) => [id, [] as string[]] as const),
  );
  if (unique.length === 0) return out;
  for (const row of await liveGtinRows(db, unique)) {
    out.get(row.productId)?.push(row.externalId);
  }
  return out;
};

/**
 * Does this product carry this barcode, in ANY encoding?
 *
 * Correlated against `product.id`, so it composes into an existing product
 * WHERE clause. Returns a never-true predicate for a value that is not a
 * barcode, so a malformed scan finds nothing instead of everything.
 */
/**
 * Free-text barcode search, against ANY of the product's barcodes — a second
 * barcode exists precisely so the item can be found by it.
 *
 * Substring rather than exact: the operator types the digits they can read off
 * the package, which for a stored GTIN-14 is usually a suffix of it.
 */
export const productMatchesGtinTerm = (term: string): SQL => {
  const terms = [...new Set(productCodeSearchTerms(term.trim()))];
  return sql`EXISTS (
    SELECT 1 FROM "ProductExternalId" pei
    WHERE pei."productId" = ${product.id}
      AND pei."source" = ${GTIN_SOURCE}
      AND pei."deletedAt" IS NULL
      AND (${sql.join(
        terms.map(
          (candidate) => sql`pei."externalId" ILIKE ${`%${candidate}%`}`,
        ),
        sql` OR `,
      )}))`;
};

export const productHasAnyGtin = (): SQL => sql`EXISTS (
  SELECT 1 FROM "ProductExternalId" pei
  WHERE pei."productId" = ${product.id}
    AND pei."source" = ${GTIN_SOURCE}
    AND pei."deletedAt" IS NULL)`;

export const productHasGtin = (value: string): SQL => {
  const normalized = normalizeGtin(value);
  if (normalized === null) return sql`false`;
  return sql`EXISTS (
    SELECT 1 FROM "ProductExternalId" pei
    WHERE pei."productId" = ${product.id}
      AND pei."source" = ${GTIN_SOURCE}
      AND pei."kind" = ${GTIN_KIND}
      AND pei."deletedAt" IS NULL
      AND pei."externalId" = ${normalized})`;
};
