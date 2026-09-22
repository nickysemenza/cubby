import {
  GTIN_KIND,
  GTIN_SOURCE,
  normalizeGtin,
} from "@cubby/schemas/external-id";
import type { ProductId } from "@cubby/schemas/identifiers";
import type {
  ProductListInventoryEntryOut,
  ProductTopLevelOut,
} from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { type FoodLookupParam, foodLookupParam } from "@cubby/usda-schemas";
import { and, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { match } from "ts-pattern";

import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import type { Database } from "~/server/db";
import { inventoryEntry, product, productExternalId } from "~/server/db/schema";
import { attachDataQuality } from "~/server/repo/data-quality";
import { getDb, imageOrder, notDeleted } from "~/server/repo/database-helpers";
import { categorySummarySql } from "~/server/repo/product-category-sql";

import { productClassificationEvidenceSql } from "./classification-evidence";
import { getProductCoverImageUrlsByProductIds } from "./crud";
import { loadPrimaryGtins, productHasGtin } from "./gtin";
import { foodLookupParamFromProduct } from "./helpers";
import {
  dbProductToTopLevelAPI,
  mapProductListInventoryEntries,
} from "./mappers";
import { enrichProductRowsWithPricing } from "./pricing";

const productMatchesFoodLookup = (
  linkedProduct: {
    fdc_id: number | null;
    externalIds: ReadonlyArray<{
      source: string;
      kind: string;
      externalId: string;
    }>;
  },
  lookup: FoodLookupParam,
): boolean =>
  match(lookup)
    .with({ kind: "fdc" }, ({ fdc_id }) => linkedProduct.fdc_id === fdc_id)
    .with({ kind: "ndb" }, () => false)
    .with({ kind: "upc" }, ({ gtin_upc }) => {
      const normalized = normalizeGtin(gtin_upc);
      return (
        normalized !== null &&
        linkedProduct.externalIds.some(
          (externalId) =>
            externalId.source === GTIN_SOURCE &&
            externalId.kind === GTIN_KIND &&
            externalId.externalId === normalized,
        )
      );
    })
    .exhaustive();

const productFoodLinkCondition = (lookups: readonly FoodLookupParam[]) =>
  or(
    ...lookups.map((lookup) =>
      match(lookup)
        .with({ kind: "upc" }, (value) => productHasGtin(value.gtin_upc))
        .with({ kind: "fdc" }, (value) => eq(product.fdc_id, value.fdc_id))
        .with({ kind: "ndb" }, () => sql`false`)
        .exhaustive(),
    ),
  );

/**
 * Resolve every USDA identifier with one product projection.
 *
 * Pricing and data-quality enrichment are themselves batch reads, so the query
 * count is bounded by the projection depth rather than the USDA page size.
 * Results preserve input order (including duplicates) for direct correlation
 * by service callers.
 */
export const findProductsByFoodIdentifiers = async (
  db: Database,
  rawLookups: readonly FoodLookupParam[],
): Promise<ProductTopLevelOut[][]> => {
  if (rawLookups.length === 0) {
    return [];
  }

  const lookups = rawLookups.map((lookup) => foodLookupParam.parse(lookup));

  // Find all matching products (exclude soft-deleted). A product links to a food
  // by its explicit fdc_id or by any of its barcodes. Products no longer store
  // an NDB number, so an NDB-keyed lookup (still a valid way to identify a USDA
  // food) matches nothing on the product side.
  //
  // `productHasGtin` normalizes, which is a recall FIX as well as a port: USDA
  // hands us a 12-digit `gtin_upc`, and a product holding the 13- or 14-digit
  // form of that same barcode never matched the old `eq(product.upc, ...)`.
  const linkCondition = productFoodLinkCondition(lookups);

  const res = await getDb(db).query.product.findMany({
    where: and(linkCondition, notDeleted(product)),
    extras: {
      category: categorySummarySql(sql`${product.categoryId}`).as("category"),
      classificationEvidence: productClassificationEvidenceSql(
        sql`${product.id}`,
      ).as("classificationEvidence"),
    },
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
  const qualified = await attachDataQuality(db, "product", priced);
  const coverImageUrls = await getProductCoverImageUrlsByProductIds(
    db,
    qualified.map((row) => row.id),
  );
  const linkedProducts = qualified.map((row) =>
    dbProductToTopLevelAPI({
      ...row,
      coverImageUrl: coverImageUrls.get(row.id) ?? null,
    }),
  );
  return lookups.map((lookup) =>
    linkedProducts.filter((linkedProduct) =>
      productMatchesFoodLookup(linkedProduct, lookup),
    ),
  );
};

/**
 * Count live product links for USDA foods without loading images, pricing, or
 * data-quality. List sorting needs only this association; the selected page is
 * enriched by {@link findProductsByFoodIdentifiers} afterwards.
 */
export const countProductsByFoodIdentifiers = async (
  db: Database,
  rawLookups: readonly FoodLookupParam[],
): Promise<number[]> => {
  if (rawLookups.length === 0) return [];

  const lookups = rawLookups.map((lookup) => foodLookupParam.parse(lookup));
  const linkCondition = productFoodLinkCondition(lookups);
  const products = await getDb(db).query.product.findMany({
    where: and(linkCondition, notDeleted(product)),
    columns: { fdc_id: true },
    with: { externalIds: { where: notDeleted(productExternalId) } },
  });
  return lookups.map(
    (lookup) =>
      products.filter((linkedProduct) =>
        productMatchesFoodLookup(linkedProduct, lookup),
      ).length,
  );
};

export const findProductsByFoodIdentifier = async (
  db: Database,
  rawLookup?: FoodLookupParam,
): Promise<ProductTopLevelOut[]> => {
  if (!rawLookup) return [];
  return (await findProductsByFoodIdentifiers(db, [rawLookup]))[0] ?? [];
};

export const getFoodLookupsForLinkedProducts = async (
  db: Database,
): Promise<FoodLookupParam[]> => {
  const rows = await getDb(db).query.product.findMany({
    where: notDeleted(product),
    columns: { id: true, fdc_id: true },
  });
  const gtins = await loadPrimaryGtins(
    db,
    rows.filter((row) => row.fdc_id == null).map((row) => row.id),
  );

  return rows.flatMap((row): FoodLookupParam[] => {
    const param = foodLookupParamFromProduct({
      fdc_id: row.fdc_id,
      primaryGtin: gtins.get(row.id) ?? null,
    });
    return param ? [param] : [];
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
    extras: {
      category: categorySummarySql(sql`${product.categoryId}`).as("category"),
      classificationEvidence: productClassificationEvidenceSql(
        sql`${product.id}`,
      ).as("classificationEvidence"),
    },
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
  const qualified = (await attachDataQuality(db, "product", [priced]))[0];
  if (!qualified) return null;
  const coverImageUrl =
    (await getProductCoverImageUrlsByProductIds(db, [qualified.id])).get(
      qualified.id,
    ) ?? null;
  return dbProductToTopLevelAPI({ ...qualified, coverImageUrl });
};

/**
 * The product carrying this barcode, in ANY encoding (excludes soft-deleted).
 *
 * A 12-digit scan finds the product stored as the 13-digit reprint, because
 * both sides go through GTIN-14. Returning a single product stays honest
 * because `ProductExternalId_source_kind_externalId_key` guarantees one live
 * owner per barcode — the same guarantee `Product_upc_key` gave, minus the
 * length-sensitivity that let one item exist twice under two encodings.
 */
export const findProductByGtin = (
  db: Database,
  barcode: string,
): Promise<ProductTopLevelOut | null> =>
  findProductToAPI(db, and(productHasGtin(barcode), notDeleted(product)));

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
