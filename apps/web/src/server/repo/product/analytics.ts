/**
 * Product analytics operations.
 * Category distribution, duplicate detection, and backfill operations.
 */

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { ActorContext } from "~/schemas/context";
import { hasFoodIndicators, type ProductCategory } from "~/schemas/product";
import type { Database } from "~/server/db";
import { image, product, productImage } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import { getDb } from "~/server/repo/database-helpers";

// Find products with expectedQuantity=1 that appear in multiple locations
export const findDuplicateUniqueProducts = async (db: Database) => {
  const duplicates = await getDb(db).query.product.findMany({
    where: eq(product.expectedQuantity, 1),
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
 * Find all products that have a UPC but no UPC-fetched image.
 * Products may have other images (user-uploaded), but are missing the UPC image.
 * Used for UPC image backfill functionality.
 */
export const findProductsWithUPCNoImages = async (
  db: Database,
): Promise<
  Array<{ id: string; name: string; manufacturer: string; upc: string }>
> => {
  const dbClient = getDb(db);

  // Get all products with UPCs and their images in a single query
  const productsWithImages = await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      upc: product.upc,
      imageUrl: image.url,
    })
    .from(product)
    .leftJoin(productImage, eq(productImage.productId, product.id))
    .leftJoin(image, eq(productImage.imageId, image.id))
    .where(and(isNotNull(product.upc), isNull(product.deletedAt)));

  // Group by product and check for UPC images
  const productMap = new Map<
    string,
    { name: string; manufacturer: string; upc: string; hasUPCImage: boolean }
  >();

  for (const row of productsWithImages) {
    if (!row.upc) continue;

    const existing = productMap.get(row.id);
    const isUPCImage = row.imageUrl?.includes("/upc-") ?? false;

    if (existing) {
      // Update if this row has a UPC image
      if (isUPCImage) {
        existing.hasUPCImage = true;
      }
    } else {
      productMap.set(row.id, {
        name: row.name,
        manufacturer: row.manufacturer,
        upc: row.upc,
        hasUPCImage: isUPCImage,
      });
    }
  }

  // Return products without UPC images
  const results: Array<{
    id: string;
    name: string;
    manufacturer: string;
    upc: string;
  }> = [];
  for (const [id, data] of productMap) {
    if (!data.hasUPCImage) {
      results.push({
        id,
        name: data.name,
        manufacturer: data.manufacturer,
        upc: data.upc,
      });
    }
  }

  return results;
};

/**
 * Find all products that have food indicators (UPC, NDB, or ingredient) but category is not "food".
 * Used for food category backfill functionality.
 */
export const findProductsNeedingFoodCategory = async (
  db: Database,
): Promise<
  Array<{
    id: string;
    name: string;
    manufacturer: string;
    category: string | null;
    upc: string | null;
    ndb_number: number | null;
    ingredientId: string | null;
  }>
> => {
  const dbClient = getDb(db);

  // Find products with food indicators but wrong category
  const products = await dbClient.query.product.findMany({
    where: isNull(product.deletedAt),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      category: true,
      upc: true,
      ndb_number: true,
      ingredientId: true,
    },
  });

  // Filter to products with food indicators but wrong category
  return products.filter((p) => hasFoodIndicators(p) && p.category !== "food");
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
    where: isNull(product.deletedAt),
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

  // Log audit entries for each update
  for (const p of productsToUpdate) {
    await logAuditEntry(db, actor, {
      entityType: "product",
      entityId: p.id,
      action: "update",
      changes: {
        category: { from: p.category, to: "food" },
      },
    });
  }

  return {
    updated: productsToUpdate.length,
    products: productsToUpdate.map((p) => ({ id: p.id, name: p.name })),
  };
};
