/**
 * Product lookup and search operations.
 * Find products by various identifiers (UPC, name, manufacturer).
 */

import type { ProductId } from "@cubby/schemas/identifiers";
import type {
  ProductListInventoryEntryOut,
  ProductTopLevelOut,
} from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { type FoodLookupParam, foodLookupParam } from "@cubby/usda-schemas";
import { and, eq, ilike, inArray, type SQL, sql } from "drizzle-orm";
import { match } from "ts-pattern";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import type { Database } from "~/server/db";
import { inventoryEntry, product } from "~/server/db/schema";
import { enrichProductRowsWithDataQuality } from "~/server/repo/data-quality";
import { getDb, imageOrder, notDeleted } from "~/server/repo/database-helpers";
import {
  dbProductToTopLevelAPI,
  mapProductListInventoryEntries,
} from "./mappers";
import { enrichProductRowsWithPricing } from "./pricing";

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
    with: {
      externalIds: true,
      images: {
        orderBy: imageOrder,
        with: {
          image: true,
        },
      },
    },
  });

  const priced = await enrichProductRowsWithPricing(db, res);
  const qualified = await enrichProductRowsWithDataQuality(db, priced);
  return qualified.map(dbProductToTopLevelAPI);
};

export const getFoodLookupsForLinkedProducts = async (
  db: Database,
): Promise<FoodLookupParam[]> => {
  const rows = await getDb(db).query.product.findMany({
    where: notDeleted(product),
    columns: {
      fdc_id: true,
      upc: true,
    },
  });

  return rows.flatMap((row): FoodLookupParam[] => {
    if (row.fdc_id != null) {
      return [{ kind: "fdc" as const, fdc_id: row.fdc_id }];
    }
    if (row.upc != null) {
      return [{ kind: "upc" as const, gtin_upc: row.upc }];
    }
    return [];
  });
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
      externalIds: true,
      images: {
        orderBy: imageOrder,
        with: {
          image: true,
        },
      },
    },
  });

  if (!res) {
    return null;
  }

  const priced = (await enrichProductRowsWithPricing(db, [res]))[0];
  if (!priced) return null;
  const qualified = (await enrichProductRowsWithDataQuality(db, [priced]))[0];
  return qualified ? dbProductToTopLevelAPI(qualified) : null;
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

/**
 * Live stock entries, with their locations, for a bounded set of products.
 *
 * One grouped read for the whole batch — the same shape as `taskSubtaskCounts`
 * and `taskDependencyIds`, and for the same reason: the callers are table pages
 * resolving a product reference per row, so a per-row read would be N+1.
 * `InventoryEntry_productId_idx` covers the lookup.
 *
 * Rows are mapped through `mapProductListInventoryEntries`, so soft-deleted
 * locations drop out here exactly as they do on the product list.
 */
export const loadProductInventoryEntries = async (
  db: Database,
  ids: readonly ProductId[],
): Promise<Map<ProductId, ProductListInventoryEntryOut[]>> => {
  const out = new Map<ProductId, ProductListInventoryEntryOut[]>();
  if (ids.length === 0) return out;

  const rows = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.productId, [...ids]),
      notDeleted(inventoryEntry),
    ),
    orderBy: inventoryEntry.createdAt,
    with: { location: true },
  });

  const byProduct = new Map<ProductId, typeof rows>();
  for (const row of rows) {
    const bucket = byProduct.get(row.productId);
    if (bucket) bucket.push(row);
    else byProduct.set(row.productId, [row]);
  }
  for (const [productId, entries] of byProduct) {
    out.set(productId, mapProductListInventoryEntries(entries));
  }
  return out;
};
