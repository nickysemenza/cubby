import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
/**
 * Product analytics operations.
 * Category distribution, duplicate detection, and backfill operations.
 */
import type { ProductCategory } from "@cubby/schemas/product";
import { isCollectionTag } from "@cubby/shared/collection-tag";
import {
  and,
  arrayOverlaps,
  eq,
  isNull,
  ne,
  notExists,
  sql,
} from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  image,
  inventoryEntry,
  product,
  productExternalId,
  productImage,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { categorySummarySql } from "~/server/repo/product-category-sql";

import { loadPrimaryGtins, productHasAnyGtin } from "./gtin";

export const findDuplicateUniqueProducts = async (
  db: Database,
  { excludeLocationId }: { excludeLocationId?: LocationId } = {},
) => {
  const duplicates = await getDb(db).query.product.findMany({
    where: and(eq(product.expectedQuantity, 1), notDeleted(product)),
    extras: {
      category: categorySummarySql(sql`${product.categoryId}`).as("category"),
    },
    with: {
      inventoryEntry: {
        where: notDeleted(inventoryEntry),
        with: {
          location: true,
        },
      },
    },
  });

  return duplicates.filter((prod) => {
    if (prod.inventoryEntry.length <= 1) return false;
    if (
      excludeLocationId &&
      prod.inventoryEntry.some(
        (entry) => entry.location.id === excludeLocationId,
      )
    ) {
      return false;
    }
    return true;
  });
};

export const findProductsWithNoImages = async (
  db: Database,
  { excludeIngredients = false } = {},
): Promise<
  Array<{
    id: ProductId;
    shortcode: string;
    name: string;
    manufacturer: string;
    primaryGtin: string | null;
  }>
> => {
  const dbClient = getDb(db);

  const conditions = [notDeleted(product)];
  if (excludeIngredients) {
    conditions.push(isNull(product.ingredientId));
  }

  // PDF manuals live in the same Image table/join — count only displayable
  // (non-PDF) attachments so a manual-only product still reads as "no images".
  const results = await dbClient
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
    })
    .from(product)
    .leftJoin(
      productImage,
      and(
        eq(productImage.productId, product.id),
        notDeleted(productImage),
        sql`${productImage.purpose} IS DISTINCT FROM 'label'`,
      ),
    )
    .leftJoin(
      image,
      and(eq(image.id, productImage.imageId), displayableImageWhere),
    )
    .where(and(...conditions))
    .groupBy(product.id)
    .having(sql`count(${image.id}) = 0`);

  // The barcode is what the image backfill looks the product up BY, so it is
  // carried on the row rather than re-fetched per candidate downstream.
  const gtins = await loadPrimaryGtins(
    db,
    results.map((row) => row.id),
  );
  return results.map((row) => ({
    ...row,
    primaryGtin: gtins.get(row.id) ?? null,
  }));
};

/**
 * Scalar counterpart of the Maintenance card's barcode-backed image backfill
 * candidate list. The action still loads presenter rows through
 * {@link findProductsWithNoImages}; its always-on count must not ship each
 * product and GTIN across the connection merely to return a number.
 */
export const countProductsWithNoImagesWithGtin = async (
  db: Database,
): Promise<number> => {
  const dbClient = getDb(db);
  const [row] = await dbClient
    .select({ count: sql<number>`count(*)::int` })
    .from(product)
    .where(
      and(
        notDeleted(product),
        isNull(product.ingredientId),
        productHasAnyGtin(),
        notExists(
          dbClient
            .select({ one: sql`1` })
            .from(productImage)
            .innerJoin(image, eq(image.id, productImage.imageId))
            .where(
              and(
                eq(productImage.productId, product.id),
                notDeleted(productImage),
                sql`${productImage.purpose} IS DISTINCT FROM 'label'`,
                displayableImageWhere,
              ),
            ),
        ),
      ),
    );
  return row?.count ?? 0;
};

/**
 * The distinct tag roster with usage counts, ranked by frequency then
 * alphabetically — feeds the product list's Tags filter picklist.
 *
 * Grouped SQL over `unnest`, not recipe/queries.ts's `getAllTags`, which loads
 * every row's tags and de-dupes into a Set in JS. Same "cheap options query"
 * shape as `vendorOptions` (repo/vendor.ts).
 */
export const getProductTagOptions = async (
  db: Database,
): Promise<Array<{ tag: string; count: number }>> => {
  const rows = await getDb(db)
    .select({
      tag: sql<string>`tag`,
      count: sql<number>`count(*)::int`,
    })
    .from(sql`${product}, unnest(${product.tags}) AS tag`)
    .where(and(notDeleted(product), sql`tag NOT LIKE 'collection:%'`))
    .groupBy(sql`tag`)
    .orderBy(sql`count(*) DESC, tag ASC`);

  return rows;
};

export const getProductExternalIdSourceOptions = async (
  db: Database,
): Promise<Array<{ source: string; count: number }>> =>
  getDb(db)
    .select({
      source: productExternalId.source,
      count: sql<number>`count(distinct ${productExternalId.productId})::int`,
    })
    .from(productExternalId)
    .innerJoin(product, eq(product.id, productExternalId.productId))
    .where(and(notDeleted(productExternalId), notDeleted(product)))
    .groupBy(productExternalId.source)
    .orderBy(
      sql`count(distinct ${productExternalId.productId}) DESC`,
      productExternalId.source,
    );

export const getProductManufacturerOptions = async (
  db: Database,
): Promise<Array<{ manufacturer: string; count: number }>> =>
  getDb(db)
    .select({
      manufacturer: product.manufacturer,
      count: sql<number>`count(*)::int`,
    })
    .from(product)
    .where(notDeleted(product))
    .groupBy(product.manufacturer)
    .orderBy(sql`count(*) DESC`, product.manufacturer);

/**
 * Every other product sharing at least one tag with `id` — the "fits with this"
 * roster on the product detail page.
 *
 * Returns each sibling's full `tags` so the caller can group by the shared tag
 * without a second round trip. Intersecting in the component rather than
 * pivoting in SQL keeps this a single flat query.
 *
 * Ecosystem tags ARE tiny (`M18` is 6 products), but provenance tags are not —
 * `home-depot-import` is 536 and `amazon` 324, so this is a few hundred scalar
 * rows on the widest tag, not the handful an ecosystem tag suggests. Still one
 * indexed scan and no pivot; sizing decisions here should use the provenance
 * numbers rather than the ecosystem ones.
 *
 * Empty tags short-circuits: `arrayOverlaps` against `'{}'` matches nothing, so
 * the query would be a guaranteed-empty scan.
 */
export const getProductsSharingTags = async (
  db: Database,
  id: ProductId,
): Promise<
  Array<{
    id: ProductId;
    shortcode: string;
    name: string;
    manufacturer: string;
    category: ProductCategory | null;
    tags: string[];
  }>
> => {
  const source = await getDb(db)
    .select({ tags: product.tags })
    .from(product)
    .where(and(eq(product.id, id), notDeleted(product)))
    .limit(1);

  const tags = (source[0]?.tags ?? []).filter((tag) => !isCollectionTag(tag));
  if (tags.length === 0) return [];

  return await getDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      category: categorySummarySql(sql`${product.categoryId}`),
      tags: product.tags,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        ne(product.id, id),
        arrayOverlaps(product.tags, tags),
      ),
    )
    .orderBy(product.name);
};

export const getCategoryDistribution = async (
  db: Database,
): Promise<
  Array<{
    category: ProductCategory | null;
    productCount: number;
    locations: Array<{ id: string; name: string; count: number }>;
  }>
> => {
  const dbClient = getDb(db);

  const productsWithInventory = await dbClient.query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      categoryId: true,
    },
    extras: {
      category: categorySummarySql(sql`${product.categoryId}`).as("category"),
    },
    with: {
      inventoryEntry: {
        where: notDeleted(inventoryEntry),
        columns: {},
        with: {
          location: {
            columns: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  const categoryMap = new Map<
    string | null,
    {
      category: ProductCategory | null;
      productCount: number;
      locationCounts: Map<string, { id: string; name: string; count: number }>;
    }
  >();

  for (const prod of productsWithInventory) {
    const cat = prod.category?.id ?? null;

    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, {
        category: prod.category,
        productCount: 0,
        locationCounts: new Map(),
      });
    }

    const catData = categoryMap.get(cat)!;
    catData.productCount++;

    for (const entry of prod.inventoryEntry) {
      const loc = entry.location;
      const existing = catData.locationCounts.get(loc.id);
      if (existing) {
        existing.count++;
      } else {
        catData.locationCounts.set(loc.id, {
          id: loc.id,
          name: loc.name,
          count: 1,
        });
      }
    }
  }

  const result: Array<{
    category: ProductCategory | null;
    productCount: number;
    locations: Array<{ id: string; name: string; count: number }>;
  }> = [];

  for (const data of categoryMap.values()) {
    const locations = Array.from(data.locationCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    result.push({
      category: data.category,
      productCount: data.productCount,
      locations,
    });
  }

  result.sort((a, b) => b.productCount - a.productCount);

  return result;
};
