import { type Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import {
  product,
  inventoryEntry,
  location,
  productUnitMappings,
} from "~/server/db/schema";
import { eq, sql, notExists, and } from "drizzle-orm";

// Interface for the complete problems result
export interface AllProblems {
  duplicateUniqueProducts: DuplicateUniqueProduct[];
  orphanedProducts: OrphanedProduct[];
  invalidUPCs: InvalidUPC[];
  productsWithoutMappings: ProductWithoutMappings[];
  invalidInventoryAmounts: InvalidInventoryAmount[];
  emptyLocations: EmptyLocation[];
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

// Find products with expectedQuantity=1 that appear in multiple locations
export const findDuplicateUniqueProducts = async (
  db: Database,
  projectId: string,
): Promise<DuplicateUniqueProduct[]> => {
  const duplicates = await getDb(db).query.product.findMany({
    where: eq(product.projectId, projectId),
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
export const findOrphanedProducts = async (
  db: Database,
  projectId: string,
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
        eq(product.projectId, projectId),
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
export const findInvalidUPCs = async (
  db: Database,
  projectId: string,
): Promise<InvalidUPC[]> => {
  const problems: InvalidUPC[] = [];

  // Find products with UPCs
  const productsWithUPCs = await getDb(db).query.product.findMany({
    where: sql`${product.projectId} = ${projectId} AND ${product.upc} IS NOT NULL`,
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      upc: true,
    },
  });

  // Check for invalid UPC formats (should be 8 or 12 digits)
  for (const prod of productsWithUPCs) {
    if (prod.upc) {
      const cleanUpc = prod.upc.replace(/[\s-]/g, "");
      if (!/^\d{8}$/.test(cleanUpc) && !/^\d{12}$/.test(cleanUpc)) {
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
    if (prod.upc) {
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
export const findProductsWithoutMappings = async (
  db: Database,
  projectId: string,
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
        eq(product.projectId, projectId),
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(productUnitMappings)
            .where(eq(productUnitMappings.productId, product.id)),
        ),
      ),
    );

  return productsWithoutMappings;
};

// Find inventory entries with zero or negative amounts
export const findInvalidInventoryAmounts = async (
  db: Database,
  projectId: string,
): Promise<InvalidInventoryAmount[]> => {
  const inventoryEntries = await getDb(db).query.inventoryEntry.findMany({
    where: eq(inventoryEntry.projectId, projectId),
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
    const amount = entry.amount as { value: number; unit: string };

    if (amount.value <= 0) {
      problems.push({
        id: entry.id,
        productName: entry.Product.name,
        locationName: entry.location.name,
        amount,
        issue: amount.value === 0 ? "zero" : "negative",
      });
    }
  }

  return problems;
};

// Find locations with no inventory entries
export const findEmptyLocations = async (
  db: Database,
  projectId: string,
): Promise<EmptyLocation[]> => {
  const dbClient = getDb(db);

  const emptyLocations = await dbClient
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
        eq(location.projectId, projectId),
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(inventoryEntry)
            .where(eq(inventoryEntry.locationId, location.id)),
        ),
      ),
    );

  return emptyLocations;
};

// Main function to get all problems
export const findAllProblems = async (
  db: Database,
  projectId: string,
): Promise<AllProblems> => {
  // Run all checks in parallel for better performance
  const [
    duplicateUniqueProducts,
    orphanedProducts,
    invalidUPCs,
    productsWithoutMappings,
    invalidInventoryAmounts,
    emptyLocations,
  ] = await Promise.all([
    findDuplicateUniqueProducts(db, projectId),
    findOrphanedProducts(db, projectId),
    findInvalidUPCs(db, projectId),
    findProductsWithoutMappings(db, projectId),
    findInvalidInventoryAmounts(db, projectId),
    findEmptyLocations(db, projectId),
  ]);

  const totalProblems =
    duplicateUniqueProducts.length +
    orphanedProducts.length +
    invalidUPCs.length +
    productsWithoutMappings.length +
    invalidInventoryAmounts.length +
    emptyLocations.length;

  return {
    duplicateUniqueProducts,
    orphanedProducts,
    invalidUPCs,
    productsWithoutMappings,
    invalidInventoryAmounts,
    emptyLocations,
    totalProblems,
  };
};
