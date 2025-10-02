import { type Database } from "~/server/db";

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
  const duplicates = await db.product.findMany({
    where: {
      projectId,
      expectedQuantity: 1,
    },
    include: {
      InventoryEntry: {
        include: {
          location: true,
        },
      },
    },
  });

  return duplicates
    .filter((product) => product.InventoryEntry.length > 1)
    .map((product) => ({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      expectedQuantity: product.expectedQuantity,
      locations: product.InventoryEntry.map((entry) => ({
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
  const orphaned = await db.product.findMany({
    where: {
      projectId,
      InventoryEntry: {
        none: {},
      },
    },
    select: {
      id: true,
      name: true,
      manufacturer: true,
      createdAt: true,
    },
  });

  return orphaned;
};

// Find products with invalid or duplicate UPC codes
export const findInvalidUPCs = async (
  db: Database,
  projectId: string,
): Promise<InvalidUPC[]> => {
  const problems: InvalidUPC[] = [];

  // Find products with UPCs
  const productsWithUPCs = await db.product.findMany({
    where: {
      projectId,
      upc: {
        not: null,
      },
    },
    select: {
      id: true,
      name: true,
      manufacturer: true,
      upc: true,
    },
  });

  // Check for invalid UPC formats (should be 8 or 12 digits)
  for (const product of productsWithUPCs) {
    if (product.upc) {
      const cleanUpc = product.upc.replace(/[\s-]/g, "");
      if (!/^\d{8}$/.test(cleanUpc) && !/^\d{12}$/.test(cleanUpc)) {
        problems.push({
          id: product.id,
          name: product.name,
          manufacturer: product.manufacturer,
          upc: product.upc,
          issue: "invalid_format",
        });
      }
    }
  }

  // Find duplicate UPCs (database should prevent this, but check anyway)
  const upcCounts = new Map<string, typeof productsWithUPCs>();
  for (const product of productsWithUPCs) {
    if (product.upc) {
      const existing = upcCounts.get(product.upc);
      if (existing) {
        // Found duplicate
        problems.push({
          id: product.id,
          name: product.name,
          manufacturer: product.manufacturer,
          upc: product.upc,
          issue: "duplicate",
        });
      } else {
        upcCounts.set(product.upc, [product]);
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
  const productsWithoutMappings = await db.product.findMany({
    where: {
      projectId,
      unitMappings: {
        none: {},
      },
    },
    select: {
      id: true,
      name: true,
      manufacturer: true,
      createdAt: true,
    },
  });

  return productsWithoutMappings;
};

// Find inventory entries with zero or negative amounts
export const findInvalidInventoryAmounts = async (
  db: Database,
  projectId: string,
): Promise<InvalidInventoryAmount[]> => {
  const inventoryEntries = await db.inventoryEntry.findMany({
    where: {
      projectId,
    },
    include: {
      Product: true,
      location: true,
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
  const emptyLocations = await db.location.findMany({
    where: {
      projectId,
      InventoryEntries: {
        none: {},
      },
    },
    select: {
      id: true,
      name: true,
      type: true,
      createdAt: true,
      lastBulkInventory: true,
    },
  });

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
