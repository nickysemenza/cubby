/**
 * Product analytics operations.
 * Category distribution, duplicate detection, and backfill operations.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { ProductCategory } from "@cubby/schemas/product";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { product, productImage } from "~/server/db/schema";
import { logAuditEntries } from "~/server/repo/audit-log";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

// Find products with expectedQuantity=1 that appear in multiple locations
export const findDuplicateUniqueProducts = async (db: Database) => {
  const duplicates = await getDb(db).query.product.findMany({
    where: and(eq(product.expectedQuantity, 1), notDeleted(product)),
    with: {
      InventoryEntry: {
        with: {
          location: true,
        },
      },
    },
  });

  return duplicates.filter((prod) => prod.InventoryEntry.length > 1);
};

/**
 * Find all products that have no images at all.
 * @param excludeIngredients - If true, excludes products linked to ingredients (for problems dashboard)
 */
export const findProductsWithNoImages = async (
  db: Database,
  { excludeIngredients = false } = {},
): Promise<
  Array<{
    id: ProductId;
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

  const results = await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      upc: product.upc,
    })
    .from(product)
    .leftJoin(productImage, eq(productImage.productId, product.id))
    .where(and(...conditions))
    .groupBy(product.id)
    .having(sql`count(${productImage.imageId}) = 0`);

  return results;
};

/**
 * Find all products that have food indicators (NDB or ingredient) but category is not "food".
 * Used for food category backfill functionality.
 */
export const findProductsNeedingFoodCategory = async (
  db: Database,
): Promise<
  Array<{
    id: ProductId;
    name: string;
    manufacturer: string;
    category: string | null;
    upc: string | null;
    ndb_number: number | null;
    ingredientId: string | null;
  }>
> => {
  const dbClient = getDb(db);

  return await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      category: product.category,
      upc: product.upc,
      ndb_number: product.ndb_number,
      ingredientId: product.ingredientId,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        sql`${product.category} IS DISTINCT FROM 'food'`,
        sql`((${product.ndb_number} IS NOT NULL AND ${product.ndb_number} > 0) OR ${product.ingredientId} IS NOT NULL)`,
      ),
    );
};

/**
 * Get product distribution by category with top locations for each category.
 * Used for the category donut visualization on the Insights page.
 */
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

  // Get all products with their inventory locations
  const productsWithInventory = await dbClient.query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      category: true,
    },
    with: {
      InventoryEntry: {
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

  // Group by category and aggregate
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

    // Count locations for this product
    for (const entry of prod.InventoryEntry) {
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

  // Convert to array and sort locations by count (top 5)
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

  // Sort by product count descending
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

/**
 * Backfill food category for all products with food indicators.
 * Returns the count of products updated.
 */
export const backfillFoodCategories = async (
  db: Database,
  actor: ActorContext,
): Promise<{
  updated: number;
  products: Array<{ id: string; name: string }>;
}> => {
  const productsToUpdate = await findProductsNeedingFoodCategory(db);

  if (productsToUpdate.length === 0) {
    return { updated: 0, products: [] };
  }

  const dbClient = getDb(db);
  const productIds = productsToUpdate.map((p) => p.id);

  // Batch update all products to category = "food"
  await dbClient
    .update(product)
    .set({ category: "food" })
    .where(inArray(product.id, productIds));

  // Log audit entries in batch
  await logAuditEntries(
    db,
    actor,
    productsToUpdate.map((p) => ({
      entityType: "product" as const,
      entityId: p.id,
      action: "update" as const,
      changes: {
        category: { from: p.category, to: "food" },
      },
    })),
  );

  return {
    updated: productsToUpdate.length,
    products: productsToUpdate.map((p) => ({ id: p.id, name: p.name })),
  };
};
