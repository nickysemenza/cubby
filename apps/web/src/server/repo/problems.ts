import type { Amount } from "@cubby/schemas/codec";
import {
  type IngredientId,
  type RecipeId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import { isMiscProduct } from "@cubby/shared";
import { upc as upcSchema } from "@cubby/usda-schemas";
import { and, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import { computeParseDrift, hasDrift } from "~/lib/parse-drift";
import { wasm } from "~/lib/wasm";
import type { Database } from "~/server/db";
import {
  ingredient,
  inventoryEntry,
  location,
  locationImage,
  product,
  productUnitMappings,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  parseInventoryAmount,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { findInventoryWithStaleValuations } from "~/server/repo/inventory/crud";
import {
  findProductsNeedingFoodCategory,
  findProductsWithNoImages,
} from "~/server/repo/product";
import { markRecipesStale } from "~/server/repo/recipe/totals";

// Interface for the complete problems result
interface AllProblems {
  duplicateUniqueProducts: DuplicateUniqueProduct[];
  orphanedProducts: OrphanedProduct[];
  invalidUPCs: InvalidUPC[];
  productsWithoutMappings: ProductWithoutMappings[];
  invalidInventoryAmounts: InvalidInventoryAmount[];
  emptyLocations: EmptyLocation[];
  productsWithNoImages: ProductWithNoImages[];
  productsWithWrongCategory: ProductWithWrongCategory[];
  inventoryWithStaleValuations: InventoryWithStaleValuation[];
  productsWithIslandedMappings: ProductWithIslandedMappings[];
  locationsWithoutAiDescription: LocationWithoutAiDescription[];
  staleIngredientParses: StaleIngredientParse[];
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
  aiDescription: string | null;
  firstImageUrl: string | null;
  firstImageId: string | null;
}

export interface ProductWithNoImages {
  id: string;
  name: string;
  manufacturer: string;
  upc: string | null;
}

export interface ProductWithWrongCategory {
  id: string;
  name: string;
  manufacturer: string;
  category: string | null;
  indicator: "ndb" | "ingredient";
}

export interface InventoryWithStaleValuation {
  id: string;
  productName: string;
  locationName: string;
  storedValuation: number | null;
  expectedValuation: number | null;
}

export interface ProductWithIslandedMappings {
  id: string;
  name: string;
  manufacturer: string;
  islandCount: number;
  islands: Array<{
    units: string[]; // Up to 3 representative units from this island
    exampleUnit: string; // Most important unit for badge display
  }>;
}

export interface LocationWithoutAiDescription {
  id: string;
  name: string;
  type: string;
  imageCount: number;
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
        where: notDeleted(inventoryEntry),
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
    where: and(notDeleted(product), isNotNull(product.upc)),
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

// Find products with no conversion/price coverage at all. A product is covered
// if it has a manual unit mapping OR a price (synthesizes a `1 each = $price`
// edge) OR a USDA link (ndb_number/upc synthesizes portion/serving/nutrient
// edges). Mirrors the costing-gap classifier in lib/recipe-costing-gaps.ts.
// Excludes misc products since they don't need pricing.
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
        isNull(product.price),
        isNull(product.ndb_number),
        isNull(product.upc),
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
      aiDescription: location.aiDescription,
      firstImageUrl: sql<string | null>`(
        SELECT "Image"."url" FROM "LocationImage"
        JOIN "Image" ON "Image"."id" = "LocationImage"."imageId"
        WHERE "LocationImage"."locationId" = "Location"."id"
        ORDER BY "LocationImage"."createdAt" ASC
        LIMIT 1
      )`,
      firstImageId: sql<string | null>`(
        SELECT "Image"."id" FROM "LocationImage"
        JOIN "Image" ON "Image"."id" = "LocationImage"."imageId"
        WHERE "LocationImage"."locationId" = "Location"."id"
        ORDER BY "LocationImage"."createdAt" ASC
        LIMIT 1
      )`,
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

// Find products with disconnected unit mapping graphs (islands)
const findProductsWithIslandedMappings = async (
  db: Database,
): Promise<ProductWithIslandedMappings[]> => {
  const dbClient = getDb(db);

  // Fetch all products with their unit mappings
  const productsWithMappings = await dbClient.query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
    },
    with: {
      unitMappings: {
        where: notDeleted(productUnitMappings),
        columns: {
          a: true,
          b: true,
          source: true,
        },
      },
    },
  });

  const problems: ProductWithIslandedMappings[] = [];

  // Import WASM
  const { wasm } = await import("~/lib/wasm");

  // Use WASM to detect islands for each product
  for (const prod of productsWithMappings) {
    // Skip products with insufficient mappings (need at least 2 to form islands)
    if (prod.unitMappings.length < 2) continue;

    // Skip misc products
    if (isMiscProduct(prod.name)) continue;

    try {
      // Detect islands using WASM
      const islands = wasm.detect_unit_mapping_islands(prod.unitMappings);

      // Only flag if there are 2+ islands
      if (islands.length >= 2) {
        problems.push({
          id: prod.id,
          name: prod.name,
          manufacturer: prod.manufacturer,
          islandCount: islands.length,
          islands: islands.map((units) => ({
            units: units.slice(0, 3), // Limit to first 3 units for display
            exampleUnit: units[0] ?? "unknown",
          })),
        });
      }
    } catch (error) {
      // Log but don't fail - skip products with graph errors
      console.error(
        `Failed to detect islands for product ${prod.id} (${prod.name}):`,
        error,
      );
    }
  }

  return problems;
};

// Find locations that have images but no AI description
const findLocationsWithoutAiDescription = async (
  db: Database,
): Promise<LocationWithoutAiDescription[]> => {
  const dbClient = getDb(db);

  const results = await dbClient
    .select({
      id: location.id,
      name: location.name,
      type: location.type,
      imageCount: sql<number>`count(${locationImage.id})`,
    })
    .from(location)
    .innerJoin(locationImage, eq(locationImage.locationId, location.id))
    .where(and(notDeleted(location), isNull(location.aiDescription)))
    .groupBy(location.id, location.name, location.type);

  return results.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    imageCount: Number(r.imageCount),
  }));
};

interface ProblemsCount {
  byType: {
    duplicateUniqueProducts: number;
    orphanedProducts: number;
    invalidUPCs: number;
    productsWithoutMappings: number;
    invalidInventoryAmounts: number;
    emptyLocations: number;
    productsWithNoImages: number;
    productsWithWrongCategory: number;
    inventoryWithStaleValuations: number;
    productsWithIslandedMappings: number;
    locationsWithoutAiDescription: number;
    staleIngredientParses: number;
  };
  total: number;
}

// A stored ingredient occurrence whose original raw line, re-parsed with the
// *current* parser, now differs from what's stored on any axis — name, amounts, or
// modifier — i.e. it was parsed by an older parser and a re-parse would change it.
// All drift is equal; the per-axis booleans drive only how the panel sorts/styles.
export interface StaleIngredientParse {
  recipeSectionIngredientId: string;
  recipeId: string;
  recipeName: string;
  ingredientId: string;
  storedName: string;
  rawLine: string;
  parsedName: string;
  nameDrift: boolean;
  storedAmounts: Amount[];
  parsedAmounts: Amount[];
  amountDrift: boolean;
  storedModifier: string | null;
  parsedModifier: string | null;
  modifierDrift: boolean;
}

const findStaleIngredientParses = async (
  db: Database,
): Promise<StaleIngredientParse[]> => {
  // No vocab here — the parser is the single source of truth. Re-parse every
  // captured raw line with the current parser and flag the rows whose result
  // drifted from what's stored. Excludes recipe-link ingredients (system-named
  // "Recipe: <name>"), which legitimately differ from a plain re-parse.
  const rows = await getDb(db)
    .select({
      recipeSectionIngredientId: recipeSectionIngredient.id,
      rawLine: recipeSectionIngredient.rawLine,
      storedAmounts: recipeSectionIngredient.amounts,
      storedModifier: recipeSectionIngredient.modifier,
      ingredientId: ingredient.id,
      storedName: ingredient.name,
      storedAliases: ingredient.aliases,
      recipeId: recipe.id,
      recipeName: recipe.name,
    })
    .from(recipeSectionIngredient)
    .innerJoin(
      ingredient,
      eq(ingredient.id, recipeSectionIngredient.ingredientId),
    )
    .innerJoin(
      recipeSection,
      eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
    )
    .innerJoin(recipe, eq(recipe.id, recipeSection.recipeId))
    .where(
      and(
        notDeleted(recipeSectionIngredient),
        isNotNull(recipeSectionIngredient.rawLine),
        isNull(ingredient.recipeId),
        notDeleted(recipe),
      ),
    );

  // Re-parse each line and diff it field-by-field against what's stored, via the same
  // computeParseDrift the client surfaces use. Name matching is alias-aware (so "large
  // eggs" parsing to the alias-bearing "large brown eggs" ingredient is NOT drift); the
  // amount/modifier axes are strict — the parser is the single normalizer.
  const stale: StaleIngredientParse[] = [];
  for (const row of rows) {
    if (!row.rawLine) continue; // isNotNull already filtered; narrow the type
    const fresh = wasm.parse_ingredient(row.rawLine);
    const drift = computeParseDrift(
      {
        knownNames: [row.storedName, ...row.storedAliases],
        amounts: row.storedAmounts,
        modifier: row.storedModifier,
      },
      fresh,
    );
    if (!hasDrift(drift)) continue;
    stale.push({
      recipeSectionIngredientId: row.recipeSectionIngredientId,
      recipeId: row.recipeId,
      recipeName: row.recipeName,
      ingredientId: row.ingredientId,
      storedName: row.storedName,
      rawLine: row.rawLine,
      parsedName: fresh.name,
      nameDrift: drift.name !== null,
      storedAmounts: row.storedAmounts,
      // Carry the range upper bound (parser WAmount snake → persisted Amount
      // camel) so Re-parse All actually resolves range drift instead of
      // re-flagging the row forever.
      parsedAmounts: drift.amounts
        ? drift.amounts.map((a) => ({
            value: a.value,
            unit: a.unit,
            ...(a.upper_value != null ? { upperValue: a.upper_value } : {}),
          }))
        : [],
      amountDrift: drift.amounts !== null,
      storedModifier: row.storedModifier,
      parsedModifier: drift.modifier,
      modifierDrift: drift.modifier !== null,
    });
  }
  return stale;
};

// Apply the current parser's result to every stale ingredient line, persisting the
// fresh parse on all three axes (name, amounts, modifier). Reuses the exact scan the
// UI shows, so it fixes precisely the listed rows. Name drift re-points the ingredient
// FK via find-or-create; amounts/modifier are column writes. Idempotent — a second run
// finds nothing stale. Totals invalidation is left to the caller (recompute) plus a
// belt-and-braces markRecipesStale so the drain retries if recompute is interrupted.
export const reparseStaleIngredientParses = async (
  db: Database,
): Promise<{ updated: number; recipesAffected: RecipeId[] }> => {
  const stale = await findStaleIngredientParses(db);
  if (stale.length === 0) return { updated: 0, recipesAffected: [] };

  await withTransaction(db, async (tx) => {
    for (const row of stale) {
      const values: {
        amounts?: Amount[];
        modifier?: string | null;
        ingredientId?: IngredientId;
      } = {};
      if (row.amountDrift) values.amounts = row.parsedAmounts;
      if (row.modifierDrift) values.modifier = row.parsedModifier;
      if (row.nameDrift) {
        const ing = await findOrCreateIngredient(tx, row.parsedName);
        values.ingredientId = ing.id;
      }
      await updateAndReturn(
        tx,
        recipeSectionIngredient,
        values,
        eq(recipeSectionIngredient.id, row.recipeSectionIngredientId),
      );
    }
  });

  const recipesAffected = uniq(stale.map((s) => unsafeRecipeId(s.recipeId)));
  await markRecipesStale(db, recipesAffected);
  return { updated: stale.length, recipesAffected };
};

// Badge counts derive from the full problems scan — one source of truth, no
// parallel count queries to drift out of sync with the find* functions.
export const findAllProblemsCount = async (
  db: Database,
): Promise<ProblemsCount> => {
  const p = await findAllProblems(db);

  return {
    byType: {
      duplicateUniqueProducts: p.duplicateUniqueProducts.length,
      orphanedProducts: p.orphanedProducts.length,
      invalidUPCs: p.invalidUPCs.length,
      productsWithoutMappings: p.productsWithoutMappings.length,
      invalidInventoryAmounts: p.invalidInventoryAmounts.length,
      emptyLocations: p.emptyLocations.length,
      productsWithNoImages: p.productsWithNoImages.length,
      productsWithWrongCategory: p.productsWithWrongCategory.length,
      inventoryWithStaleValuations: p.inventoryWithStaleValuations.length,
      productsWithIslandedMappings: p.productsWithIslandedMappings.length,
      locationsWithoutAiDescription: p.locationsWithoutAiDescription.length,
      staleIngredientParses: p.staleIngredientParses.length,
    },
    total: p.totalProblems,
  };
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
    productsWithNoImages,
    productsNeedingFoodCategory,
    inventoryWithStaleValuationsRaw,
    productsWithIslandedMappings,
    locationsWithoutAiDescription,
    staleIngredientParses,
  ] = await Promise.all([
    findDuplicateUniqueProducts(db),
    findOrphanedProducts(db),
    findInvalidUPCs(db),
    findProductsWithoutMappings(db),
    findInvalidInventoryAmounts(db),
    findEmptyLocations(db),
    findProductsWithNoImages(db, { excludeIngredients: true }),
    findProductsNeedingFoodCategory(db),
    findInventoryWithStaleValuations(db),
    findProductsWithIslandedMappings(db),
    findLocationsWithoutAiDescription(db),
    findStaleIngredientParses(db),
  ]);

  // Transform to problem types
  const productsWithWrongCategory: ProductWithWrongCategory[] =
    productsNeedingFoodCategory.map((p) => ({
      id: p.id,
      name: p.name,
      manufacturer: p.manufacturer,
      category: p.category,
      indicator: getFoodIndicator(p),
    }));

  const inventoryWithStaleValuations: InventoryWithStaleValuation[] =
    inventoryWithStaleValuationsRaw;

  const totalProblems =
    duplicateUniqueProducts.length +
    orphanedProducts.length +
    invalidUPCs.length +
    productsWithoutMappings.length +
    invalidInventoryAmounts.length +
    emptyLocations.length +
    productsWithNoImages.length +
    productsWithWrongCategory.length +
    inventoryWithStaleValuations.length +
    productsWithIslandedMappings.length +
    locationsWithoutAiDescription.length +
    staleIngredientParses.length;

  return {
    duplicateUniqueProducts,
    orphanedProducts,
    invalidUPCs,
    productsWithoutMappings,
    invalidInventoryAmounts,
    emptyLocations,
    productsWithNoImages,
    productsWithWrongCategory,
    inventoryWithStaleValuations,
    productsWithIslandedMappings,
    locationsWithoutAiDescription,
    staleIngredientParses,
    totalProblems,
  };
};
