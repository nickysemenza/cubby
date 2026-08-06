/**
 * Product analytics operations.
 * Category distribution, duplicate detection, and backfill operations.
 */

import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import type { ProductCategory } from "@cubby/schemas/product";
import { and, arrayOverlaps, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  image,
  inventoryEntry,
  product,
  productImage,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { displayableImageWhere } from "~/server/repo/image-displayability";

export const findDuplicateUniqueProducts = async (
  db: Database,
  { excludeLocationId }: { excludeLocationId?: LocationId } = {},
) => {
  const duplicates = await getDb(db).query.product.findMany({
    where: and(eq(product.expectedQuantity, 1), notDeleted(product)),
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
    // Skip duplicates that involve the excluded location entirely.
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
    upc: string | null;
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
      upc: product.upc,
    })
    .from(product)
    .leftJoin(
      productImage,
      and(eq(productImage.productId, product.id), notDeleted(productImage)),
    )
    .leftJoin(
      image,
      and(eq(image.id, productImage.imageId), displayableImageWhere),
    )
    .where(and(...conditions))
    .groupBy(product.id)
    .having(sql`count(${image.id}) = 0`);

  return results;
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
    .where(notDeleted(product))
    .groupBy(sql`tag`)
    .orderBy(sql`count(*) DESC, tag ASC`);

  return rows;
};

/** Distinct server-backed manufacturer roster for exact list filtering. */
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
 * pivoting in SQL keeps this a single flat query, and the sets are tiny (the
 * largest tag group is 7 products).
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

  const tags = source[0]?.tags ?? [];
  if (tags.length === 0) return [];

  return await getDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      name: product.name,
      manufacturer: product.manufacturer,
      category: product.category,
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
      category: true,
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
    ProductCategory | null,
    {
      productCount: number;
      locationCounts: Map<string, { id: string; name: string; count: number }>;
    }
  >();

  for (const prod of productsWithInventory) {
    const cat = prod.category as ProductCategory | null;

    if (!categoryMap.has(cat)) {
      categoryMap.set(cat, {
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

  for (const [category, data] of categoryMap) {
    const locations = Array.from(data.locationCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    result.push({
      category,
      productCount: data.productCount,
      locations,
    });
  }

  result.sort((a, b) => b.productCount - a.productCount);

  return result;
};

/**
 * Get a lightweight product summary for AI category audit.
 * Returns name, manufacturer, and category for all non-deleted products.
 */
export const getProductSummaryForAudit = async (
  db: Database,
): Promise<
  Array<{ name: string; manufacturer: string; category: string | null }>
> => {
  return getDb(db)
    .select({
      name: product.name,
      manufacturer: product.manufacturer,
      category: product.category,
    })
    .from(product)
    .where(notDeleted(product));
};
