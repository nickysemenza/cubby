import { upc as upcSchema } from "@recipehub/usda-schemas";
import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { isMiscProduct } from "~/lib/constants";
import type { Database } from "~/server/db";
import {
  inventoryEntry,
  location,
  product,
  productUnitMappings,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  parseInventoryAmount,
} from "~/server/repo/database-helpers";
import { findInventoryWithStaleValuations } from "~/server/repo/inventory/crud";
import {
  findProductsNeedingFoodCategory,
  findProductsWithStalePrices,
  findProductsWithUPCNoImages,
} from "~/server/repo/product";

// Interface for the complete problems result
interface AllProblems {
  duplicateUniqueProducts: DuplicateUniqueProduct[];
  orphanedProducts: OrphanedProduct[];
  invalidUPCs: InvalidUPC[];
  productsWithoutMappings: ProductWithoutMappings[];
  invalidInventoryAmounts: InvalidInventoryAmount[];
  emptyLocations: EmptyLocation[];
  productsWithoutUPCImages: ProductWithoutUPCImage[];
  productsWithWrongCategory: ProductWithWrongCategory[];
  productsWithStalePrices: ProductWithStalePrice[];
  inventoryWithStaleValuations: InventoryWithStaleValuation[];
  totalProblems: number;
}

// Type definitions for each problem type
export interface DuplicateUniqueProduct {
  id: string;
  name: string;
  manufacturer: string;
  expectedQuantity: number | null;
  locations: Array<{
    id: string;
    name: string;
  }>;
}

export interface OrphanedProduct {
  id: string;
  name: string;
  manufacturer: string;
  createdAt: Date;
}

export interface InvalidUPC {
  id: string;
  name: string;
  manufacturer: string;
  upc: string;
  issue: "invalid_format" | "duplicate";
}

export interface ProductWithoutMappings {
  id: string;
  name: string;
  manufacturer: string;
  createdAt: Date;
}

export interface InvalidInventoryAmount {
  id: string;
  productName: string;
  locationName: string;
  amount: {
    value: number;
    unit: string;
  };
  issue: "zero" | "negative";
}

export interface EmptyLocation {
  id: string;
  name: string;
  type: string;
  createdAt: Date;
  lastBulkInventory: Date | null;
}

export interface ProductWithoutUPCImage {
  id: string;
  name: string;
  manufacturer: string;
  upc: string;
}

export interface ProductWithWrongCategory {
  id: string;
  name: string;
  manufacturer: string;
  category: string | null;
  indicator: "ndb" | "ingredient";
}

export interface ProductWithStalePrice {
  id: string;
  name: string;
  manufacturer: string;
  storedPrice: number | null;
  computedPrice: number | null;
  status: "missing" | "stale";
}

export interface InventoryWithStaleValuation {
  id: string;
  productName: string;
  locationName: string;
  storedValuation: number | null;
  expectedValuation: number | null;
}

// Find products with expectedQuantity=1 that appear in multiple locations
const findDuplicateUniqueProducts = async (
  db: Database,
): Promise<DuplicateUniqueProduct[]> => {
  const duplicates = await getDb(db).query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      expectedQuantity: true,
    },
    with: {
      InventoryEntry: {
        columns: {
          id: true,
          locationId: true,
        },
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

  return duplicates
    .filter(
      (prod) => prod.expectedQuantity === 1 && prod.InventoryEntry.length > 1,
    )
    .map((prod) => ({
      id: prod.id,
      name: prod.name,
      manufacturer: prod.manufacturer,
      expectedQuantity: prod.expectedQuantity,
      locations: prod.InventoryEntry.map((entry) => ({
        id: entry.location.id,
        name: entry.location.name,
      })),
    }));
};

// Find products that have no inventory entries
const findOrphanedProducts = async (
  db: Database,
): Promise<OrphanedProduct[]> => {
  const dbClient = getDb(db);

  const orphaned = await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      createdAt: product.createdAt,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        isNull(product.ingredientId),
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(inventoryEntry)
            .where(eq(inventoryEntry.productId, product.id)),
        ),
      ),
    );

  return orphaned;
};

// Find products with invalid or duplicate UPC codes
const findInvalidUPCs = async (db: Database): Promise<InvalidUPC[]> => {
  const problems: InvalidUPC[] = [];

  // Find products with UPCs
  const productsWithUPCs = await getDb(db).query.product.findMany({
    where: sql`${product.deletedAt} IS NULL AND ${product.upc} IS NOT NULL`,
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      upc: true,
    },
  });

  // Check for invalid barcode formats using shared schema (skip misc products)
  for (const prod of productsWithUPCs) {
    if (prod.upc && !isMiscProduct(prod.name)) {
      const result = upcSchema.safeParse(prod.upc);
      if (!result.success) {
        problems.push({
          id: prod.id,
          name: prod.name,
          manufacturer: prod.manufacturer,
          upc: prod.upc,
          issue: "invalid_format",
        });
      }
    }
  }

  // Find duplicate UPCs (database should prevent this, but check anyway)
  const upcCounts = new Map<string, typeof productsWithUPCs>();
  for (const prod of productsWithUPCs) {
    if (prod.upc && !isMiscProduct(prod.name)) {
      const existing = upcCounts.get(prod.upc);
      if (existing) {
        // Found duplicate
        problems.push({
          id: prod.id,
          name: prod.name,
          manufacturer: prod.manufacturer,
          upc: prod.upc,
          issue: "duplicate",
        });
      } else {
        upcCounts.set(prod.upc, [prod]);
      }
    }
  }

  return problems;
};

// Find products without any unit mappings (no pricing information)
// Excludes misc products since they don't need pricing
const findProductsWithoutMappings = async (
  db: Database,
): Promise<ProductWithoutMappings[]> => {
  const dbClient = getDb(db);

  const productsWithoutMappings = await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      createdAt: product.createdAt,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(productUnitMappings)
            .where(eq(productUnitMappings.productId, product.id)),
        ),
      ),
    );

  // Filter out misc products - they don't need pricing
  return productsWithoutMappings.filter((p) => !isMiscProduct(p.name));
};

// Find inventory entries with zero or negative amounts
const findInvalidInventoryAmounts = async (
  db: Database,
): Promise<InvalidInventoryAmount[]> => {
  const inventoryEntries = await getDb(db).query.inventoryEntry.findMany({
    where: notDeleted(inventoryEntry),
    columns: {
      id: true,
      amount: true,
    },
    with: {
      Product: {
        columns: {
          name: true,
        },
      },
      location: {
        columns: {
          name: true,
        },
      },
    },
  });

  const problems: InvalidInventoryAmount[] = [];

  for (const entry of inventoryEntries) {
    // Validate and parse the JSONB amount column
    const parsedAmount = parseInventoryAmount(entry.amount, entry.id);

    if (parsedAmount.value <= 0) {
      problems.push({
        id: entry.id,
        productName: entry.Product.name,
        locationName: entry.location.name,
        amount: parsedAmount,
        issue: parsedAmount.value === 0 ? "zero" : "negative",
      });
    }
  }

  return problems;
};

// Find leaf locations with no inventory entries (excludes parent locations)
const findEmptyLocations = async (db: Database): Promise<EmptyLocation[]> => {
  const dbClient = getDb(db);

  // Alias for checking child locations
  const childLocation = dbClient
    .$with("child_location")
    .as(dbClient.select({ parentId: location.parentId }).from(location));

  const emptyLocations = await dbClient
    .with(childLocation)
    .select({
      id: location.id,
      name: location.name,
      type: location.type,
      createdAt: location.createdAt,
      lastBulkInventory: location.lastBulkInventory,
    })
    .from(location)
    .where(
      and(
        notDeleted(location),
        // No inventory entries
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(inventoryEntry)
            .where(eq(inventoryEntry.locationId, location.id)),
        ),
        // No child locations (is a leaf node)
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(childLocation)
            .where(eq(childLocation.parentId, location.id)),
        ),
      ),
    );

  return emptyLocations;
};

// Helper to determine the primary food indicator for a product
// Note: hasFoodIndicators only checks NDB and ingredient, not UPC
const getFoodIndicator = (product: {
  ndb_number: number | null;
  ingredientId: string | null;
}): "ndb" | "ingredient" => {
  if (product.ndb_number != null && product.ndb_number > 0) return "ndb";
  return "ingredient";
};

// Main function to get all problems
export const findAllProblems = async (db: Database): Promise<AllProblems> => {
  // Run all checks in parallel for better performance
  const [
    duplicateUniqueProducts,
    orphanedProducts,
    invalidUPCs,
    productsWithoutMappings,
    invalidInventoryAmounts,
    emptyLocations,
    productsWithUPCNoImages,
    productsNeedingFoodCategory,
    productsWithStalePricesRaw,
    inventoryWithStaleValuationsRaw,
  ] = await Promise.all([
    findDuplicateUniqueProducts(db),
    findOrphanedProducts(db),
    findInvalidUPCs(db),
    findProductsWithoutMappings(db),
    findInvalidInventoryAmounts(db),
    findEmptyLocations(db),
    findProductsWithUPCNoImages(db),
    findProductsNeedingFoodCategory(db),
    findProductsWithStalePrices(db),
    findInventoryWithStaleValuations(db),
  ]);

  // Transform to problem types
  const productsWithoutUPCImages: ProductWithoutUPCImage[] =
    productsWithUPCNoImages;

  const productsWithWrongCategory: ProductWithWrongCategory[] =
    productsNeedingFoodCategory.map((p) => ({
      id: p.id,
      name: p.name,
      manufacturer: p.manufacturer,
      category: p.category,
      indicator: getFoodIndicator(p),
    }));

  const productsWithStalePrices: ProductWithStalePrice[] =
    productsWithStalePricesRaw;

  const inventoryWithStaleValuations: InventoryWithStaleValuation[] =
    inventoryWithStaleValuationsRaw;

  const totalProblems =
    duplicateUniqueProducts.length +
    orphanedProducts.length +
    invalidUPCs.length +
    productsWithoutMappings.length +
    invalidInventoryAmounts.length +
    emptyLocations.length +
    productsWithoutUPCImages.length +
    productsWithWrongCategory.length +
    productsWithStalePrices.length +
    inventoryWithStaleValuations.length;

  return {
    duplicateUniqueProducts,
    orphanedProducts,
    invalidUPCs,
    productsWithoutMappings,
    invalidInventoryAmounts,
    emptyLocations,
    productsWithoutUPCImages,
    productsWithWrongCategory,
    productsWithStalePrices,
    inventoryWithStaleValuations,
    totalProblems,
  };
};
