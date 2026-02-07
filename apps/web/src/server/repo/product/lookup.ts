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
import { and, eq, ilike } from "drizzle-orm";
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

  // Find all matching products (exclude soft-deleted)
  const res = await getDb(db).query.product.findMany({
    where: and(
      lookup.kind === "upc"
        ? eq(product.upc, lookup.gtin_upc)
        : eq(product.ndb_number, lookup.ndb_number),
      notDeleted(product),
    ),
    ...relations.product.full,
  });

  return res.map((p) => ({
    ...p,
    shortcode: unsafeProductShortcode(p.shortcode),
    images: extractImagesFromJoinTable(p.images),
  }));
};

// Find a product by UPC code (excludes soft-deleted)
export const findProductByUPC = async (
  db: Database,
  upcCode: string,
): Promise<ProductTopLevelOut | null> => {
  const res = await getDb(db).query.product.findFirst({
    where: and(eq(product.upc, upcCode), notDeleted(product)),
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

// Find a product by name and manufacturer (internal helper, excludes soft-deleted)
const findProductByNameAndManufacturer = async (
  db: Database,
  name: string,
  manufacturer: string,
): Promise<ProductTopLevelOut | null> => {
  const res = await getDb(db).query.product.findFirst({
    where: and(
      ilike(product.name, name),
      ilike(product.manufacturer, manufacturer),
      notDeleted(product),
    ),
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
    const res = await getDb(db).query.product.findFirst({
      where: and(ilike(product.name, name), notDeleted(product)),
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
  const unspecifiedMatch = await getDb(db).query.product.findFirst({
    where: and(
      ilike(product.name, name),
      ilike(product.manufacturer, UNSPECIFIED_MANUFACTURER),
      notDeleted(product),
    ),
    with: {
      images: {
        with: {
          image: true,
        },
      },
    },
  });

  if (!unspecifiedMatch) {
    return null;
  }

  return parseWithContext(
    productTopLevelOut,
    {
      ...unspecifiedMatch,
      images: extractImagesFromJoinTable(unspecifiedMatch.images),
    },
    {
      entityType: "Product",
      identifier: { id: unspecifiedMatch.id, name: unspecifiedMatch.name },
    },
  );
};
