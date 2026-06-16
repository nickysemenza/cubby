/**
 * Product lookup and search operations.
 * Find products by various identifiers (UPC, name, manufacturer).
 */

import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import {
  type ProductTopLevelOut,
  productTopLevelOut,
} from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { type FoodLookupParam, foodLookupParam } from "@cubby/usda-schemas";
import { and, eq, ilike, type SQL, sql } from "drizzle-orm";
import { match } from "ts-pattern";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { parseWithContext } from "~/lib/zod-utils";
import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import {
  extractImagesFromJoinTable,
  getDb,
  notDeleted,
  relations,
} from "~/server/repo/database-helpers";

/**
 * Find products by UPC or NDB number - used for food items in usda.ts
 */
export const findProductsByFoodIdentifier = async (
  db: Database,
  rawLookup?: FoodLookupParam,
) => {
  if (!rawLookup) {
    return [];
  }

  // validate that lookup zod schema is good
  const lookup = foodLookupParam.parse(rawLookup);

  // Find all matching products (exclude soft-deleted). A product links to a food
  // by its explicit fdc_id or its barcode (upc). Products no longer store an NDB
  // number, so an NDB-keyed lookup (still a valid way to identify a USDA food)
  // matches nothing on the product side.
  const linkCondition = match(lookup)
    .with({ kind: "upc" }, (l) => eq(product.upc, l.gtin_upc))
    .with({ kind: "fdc" }, (l) => eq(product.fdc_id, l.fdc_id))
    .with({ kind: "ndb" }, () => sql`false`)
    .exhaustive();

  const res = await getDb(db).query.product.findMany({
    where: and(linkCondition, notDeleted(product)),
    ...relations.product.full,
  });

  return res.map((p) => ({
    ...p,
    shortcode: unsafeProductShortcode(p.shortcode),
    images: extractImagesFromJoinTable(p.images),
  }));
};

/**
 * Run a single-product lookup and transform it to the API shape.
 * Shared by all the findProductBy* functions below: the only thing that varies
 * between them is the `where` condition.
 */
const findProductToAPI = async (
  db: Database,
  where: SQL | undefined,
): Promise<ProductTopLevelOut | null> => {
  const res = await getDb(db).query.product.findFirst({
    where,
    with: {
      images: {
        with: {
          image: true,
        },
      },
    },
  });

  if (!res) {
    return null;
  }

  return parseWithContext(
    productTopLevelOut,
    {
      ...res,
      images: extractImagesFromJoinTable(res.images),
    },
    {
      entityType: "Product",
      identifier: { id: res.id, name: res.name },
    },
  );
};

// Find a product by UPC code (excludes soft-deleted)
export const findProductByUPC = (
  db: Database,
  upcCode: string,
): Promise<ProductTopLevelOut | null> =>
  findProductToAPI(db, and(eq(product.upc, upcCode), notDeleted(product)));

// Find a product by name and manufacturer (internal helper, excludes soft-deleted)
const findProductByNameAndManufacturer = (
  db: Database,
  name: string,
  manufacturer: string,
): Promise<ProductTopLevelOut | null> =>
  findProductToAPI(
    db,
    and(
      ilike(product.name, name),
      ilike(product.manufacturer, manufacturer),
      notDeleted(product),
    ),
  );

/**
 * Find a product by name with fuzzy manufacturer matching
 *
 * Matching logic:
 * - If incoming manufacturer is unspecified → match by name only (any manufacturer)
 * - If incoming manufacturer is specific → try exact match first, then fallback
 *   to matching a product with "(unspecified)" manufacturer in DB
 *
 * This allows sheet rows with empty manufacturer to match existing products
 * regardless of their manufacturer, while specific manufacturers require
 * exact match or fallback to unspecified.
 */
export const findProductByNameFuzzyManufacturer = async (
  db: Database,
  name: string,
  manufacturer: string | null | undefined,
): Promise<ProductTopLevelOut | null> => {
  // If incoming manufacturer is unspecified, match by name only (excludes soft-deleted)
  if (isUnspecifiedManufacturer(manufacturer)) {
    return findProductToAPI(
      db,
      and(ilike(product.name, name), notDeleted(product)),
    );
  }

  // Incoming manufacturer is specific - try exact match first
  const exactMatch = await findProductByNameAndManufacturer(
    db,
    name,
    manufacturer!,
  );

  if (exactMatch) {
    return exactMatch;
  }

  // Fallback: try to match a product with "(unspecified)" manufacturer (excludes soft-deleted)
  return findProductToAPI(
    db,
    and(
      ilike(product.name, name),
      ilike(product.manufacturer, UNSPECIFIED_MANUFACTURER),
      notDeleted(product),
    ),
  );
};
