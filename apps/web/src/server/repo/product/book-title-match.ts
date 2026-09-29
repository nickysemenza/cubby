import { type ProductId, parseEntityId } from "@cubby/schemas/identifiers";
import { and, not, type SQL, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { notDeleted, unwrapDb } from "~/server/repo/database-helpers";
import { categoryFeatureSql } from "~/server/repo/product-category-sql";

import { productHasAnyGtin } from "./gtin";

/** Case, punctuation, and spacing fold, applied identically to both sides. */
const foldedTitle = (title: SQL) =>
  sql`btrim(regexp_replace(lower(${title}), '[^[:alnum:]]+', ' ', 'g'))`;

/**
 * The one live, barcode-less book Product whose title equals `title` after
 * folding case, punctuation, and spacing — the shelved copy a first ISBN scan
 * names. `null` for no match and for two or more: a tie is a human's call, and
 * a Product that already carries a barcode is a different edition.
 */
export const findUnbarcodedBookByTitle = async (
  db: Database,
  title: string,
): Promise<ProductId | null> => {
  const scanned = foldedTitle(sql`${title}::text`);
  const rows = await unwrapDb(db)
    .select({ id: product.id })
    .from(product)
    .where(
      and(
        notDeleted(product),
        categoryFeatureSql(sql`${product.categoryId}`, "books"),
        not(productHasAnyGtin()),
        sql`${scanned} <> '' AND ${foldedTitle(sql`${product.name}`)} = ${scanned}`,
      ),
    )
    .limit(2);
  const [only, other] = rows;
  return only && !other ? parseEntityId("product", only.id) : null;
};
