import type { Amount } from "@cubby/schemas/codec";
import {
  type IngredientId,
  type RecipeId,
  unsafeProductId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import type { RecipeTotals } from "@cubby/schemas/recipe";
import { isMiscProduct } from "@cubby/shared";
import { upc as upcSchema } from "@cubby/usda-schemas";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notExists,
  sql,
} from "drizzle-orm";
import { uniq } from "es-toolkit";
import {
  BASE_KINDS,
  type BaseKind,
  conversionCoverage,
} from "~/lib/conversion-coverage";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { computeParseDrift, hasDrift } from "~/lib/parse-drift";
import { isMoneyUnit } from "~/lib/price-mapping-utils";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import {
  ingredient,
  inventoryEntry,
  location,
  locationImage,
  product,
  productImage,
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
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import { markRecipesStale } from "~/server/repo/recipe/totals";
import { batchEnrichWithFood } from "~/server/services/usda-helpers";

// Interface for the complete problems result
interface AllProblems {
  duplicateUniqueProducts: DuplicateUniqueProduct[];
  orphanedProducts: OrphanedProduct[];
  invalidUPCs: InvalidUPC[];
  productsWithoutMappings: ProductWithoutMappings[];
  ingredientsWithPartialCoverage: IngredientWithPartialCoverage[];
  invalidInventoryAmounts: InvalidInventoryAmount[];
  emptyLocations: EmptyLocation[];
  productsWithNoImages: ProductWithNoImages[];
  productsWithWrongCategory: ProductWithWrongCategory[];
  inventoryWithStaleValuations: InventoryWithStaleValuation[];
  productsWithIslandedMappings: ProductWithIslandedMappings[];
  locationsWithoutAiDescription: LocationWithoutAiDescription[];
  staleIngredientParses: StaleIngredientParse[];
  staleRecipeTotals: StaleRecipeTotals[];
  productsWithBetterUpcData: ProductWithBetterUpcData[];
  totalProblems: number;
}

// Type definitions for each problem type
interface DuplicateUniqueProduct {
  id: string;
  name: string;
  manufacturer: string;
  expectedQuantity: number | null;
  locations: Array<{
    id: string;
    name: string;
  }>;
}

interface OrphanedProduct {
  id: string;
  name: string;
  manufacturer: string;
  createdAt: Date;
}

interface InvalidUPC {
  id: string;
  name: string;
  manufacturer: string;
  upc: string;
  issue: "invalid_format" | "duplicate";
}

interface ProductWithoutMappings {
  id: string;
  name: string;
  manufacturer: string;
  createdAt: Date;
  /**
   * Whether the product is linked to an ingredient — i.e. a food. Drives the
   * inline fix: ingredients get the USDA-link + price path (the "core 4"),
   * non-foods just need a price.
   */
  isIngredient: boolean;
  /** Operator-set: no USDA food exists — the fix switches to manual entry. */
  usdaUnavailable: boolean;
}

// An ingredient product that has *some* coverage but can't reach all four base
// kinds (weight/volume/money/calories) — e.g. a price but no weight/volume link,
// or a volume↔money mapping but no calories. Graded with the real conversion
// graph (conversionCoverage on synthesized mappings), so money living in a unit
// mapping counts just like a scalar price. Truly-empty products are left to
// findProductsWithoutMappings.
interface IngredientWithPartialCoverage {
  id: string;
  name: string;
  manufacturer: string;
  /** Which of the 4 base kinds the effective graph can reach (lit chips). */
  coverage: { covered: BaseKind[] };
  /**
   * Whether the product already has price info — a scalar price OR a money unit
   * mapping. Distinct from `coverage` having `money` (which means money is
   * reachable *from a measure*). Drives the fix: only offer the price step when
   * no price exists at all, so we never blank-overwrite an existing one.
   */
  hasPrice: boolean;
  /**
   * Whether a USDA food already resolves for this product. When true, the fix
   * won't offer "link a USDA food" — re-linking the same food can't fill a gap
   * the food doesn't cover (e.g. a portion with an unrecognized unit); that
   * needs a manual conversion.
   */
  hasUsdaLink: boolean;
  /**
   * Operator-set: no USDA food exists for this product. The fix then stops
   * suggesting a (futile) USDA link and switches to manual entry of the missing
   * kinds. Does NOT suppress — still flagged until they're filled.
   */
  usdaUnavailable: boolean;
}

interface InvalidInventoryAmount {
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

interface ProductWithNoImages {
  id: string;
  name: string;
  manufacturer: string;
  upc: string | null;
}

interface ProductWithWrongCategory {
  id: string;
  name: string;
  manufacturer: string;
  category: string | null;
  indicator: "ndb" | "ingredient";
}

interface InventoryWithStaleValuation {
  id: string;
  productName: string;
  locationName: string;
  storedValuation: number | null;
  expectedValuation: number | null;
}

interface ProductWithIslandedMappings {
  id: string;
  name: string;
  manufacturer: string;
  islandCount: number;
  islands: Array<{
    units: string[]; // Up to 3 representative units from this island
    exampleUnit: string; // Most important unit for badge display
  }>;
  /**
   * Which of the 4 base kinds (weight/volume/money/calories) the effective graph
   * can already reach. Computed from the same synthesized mappings used for island
   * detection, so the card's core-4 chips and the island split never disagree.
   */
  coverage: { covered: BaseKind[] };
}

interface LocationWithoutAiDescription {
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
      ingredientId: product.ingredientId,
      usdaUnavailable: product.usdaUnavailable,
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
  return productsWithoutMappings
    .filter((p) => !isMiscProduct(p.name))
    .map(({ ingredientId, usdaUnavailable, ...rest }) => ({
      ...rest,
      isIngredient: ingredientId != null,
      usdaUnavailable: usdaUnavailable ?? false,
    }));
};

// Find ingredient products that are under-covered: they have *some* coverage (so
// findProductsWithoutMappings skips them) but their effective conversion graph
// can't reach all four base kinds. Graded with conversionCoverage on the
// synthesized mappings (stored conversions + price edge + USDA edges), so money
// in a unit mapping counts like a scalar price — not just the scalar field.
//
// Cost: like the islanded detector, this enriches candidates with USDA food and
// synthesizes their mappings. The DB pre-filter drops truly-empty products
// (owned by findProductsWithoutMappings); batchEnrichWithFood only hits the
// network for candidates that actually have a upc/ndb to look up.
const findIngredientsWithPartialCoverage = async (
  db: Database,
  usdaClient: USDAClient,
): Promise<IngredientWithPartialCoverage[]> => {
  const products = await getDb(db).query.product.findMany({
    where: and(notDeleted(product), isNotNull(product.ingredientId)),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      upc: true,
      ndb_number: true,
      price: true,
      usdaUnavailable: true,
    },
    with: {
      unitMappings: {
        where: notDeleted(productUnitMappings),
        columns: { a: true, b: true, source: true },
      },
    },
  });

  const candidates = products.filter(
    (p) =>
      !isMiscProduct(p.name) &&
      // Skip truly-empty products — findProductsWithoutMappings owns those.
      (p.price != null ||
        p.ndb_number != null ||
        p.upc != null ||
        p.unitMappings.length > 0),
  );

  const enriched = await batchEnrichWithFood(
    candidates,
    foodLookupParamFromProduct,
    usdaClient,
  );

  const problems: IngredientWithPartialCoverage[] = [];
  for (const p of enriched) {
    let effective: ReturnType<typeof getAllUnitMappingsFromProduct>;
    try {
      effective = getAllUnitMappingsFromProduct({
        id: p.id,
        unitMappings: p.unitMappings,
        food: p.food,
        price: p.price,
      });
    } catch (error) {
      console.error(
        `Failed to synthesize mappings for product ${p.id} (${p.name}):`,
        error,
      );
      continue;
    }

    const cov = conversionCoverage(effective, BASE_KINDS);

    // The two actionable gaps: USDA fills weight/volume/calories, a price fills
    // money. A scalar price (or any money-unit edge) counts as "has price" even
    // though conversionCoverage won't light `money` from a bare "1 each = $X"
    // (it isn't reachable from a measure). Flag only when one of these is
    // genuinely addable, so every card maps to a concrete fix — and we don't
    // nag count-priced foods (USDA-linked + priced) over money-from-measure.
    const coversWVC =
      cov.covered.has("weight") &&
      cov.covered.has("volume") &&
      cov.covered.has("calories");
    const hasPrice =
      p.price != null ||
      effective.some((m) => isMoneyUnit(m.a.unit) || isMoneyUnit(m.b.unit));
    if (coversWVC && hasPrice) continue;

    problems.push({
      id: p.id,
      name: p.name,
      manufacturer: p.manufacturer,
      coverage: { covered: [...cov.covered] },
      hasPrice,
      hasUsdaLink: p.food != null,
      usdaUnavailable: p.usdaUnavailable ?? false,
    });
  }

  return problems;
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

// Find products with disconnected unit mapping graphs (islands).
//
// A product is only a real problem if its *effective* mappings — stored
// conversions PLUS the edges its USDA link and price synthesize — still split
// into 2+ components. A product islanded on its stored mappings alone but
// bridged into one component by USDA portion/serving edges (the same edges the
// conversion graph and costing engine use) is fully convertible, so it isn't
// flagged. This mirrors the "a USDA link counts as conversion coverage" rule in
// findProductsWithoutMappings.
const findProductsWithIslandedMappings = async (
  db: Database,
  usdaClient: USDAClient,
): Promise<ProductWithIslandedMappings[]> => {
  const dbClient = getDb(db);

  // Fetch products with their stored unit mappings, plus the fields needed to
  // synthesize their derived edges (USDA link + price).
  const productsWithMappings = await dbClient.query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      upc: true,
      ndb_number: true,
      price: true,
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

  const detectIslands = (
    mappings: Parameters<typeof wasm.detect_unit_mapping_islands>[0],
    prod: { id: string; name: string },
  ): string[][] => {
    try {
      return wasm.detect_unit_mapping_islands(mappings);
    } catch (error) {
      // Log but don't fail - skip products with graph errors
      console.error(
        `Failed to detect islands for product ${prod.id} (${prod.name}):`,
        error,
      );
      return [];
    }
  };

  // First pass: candidates are products whose STORED mappings split into 2+
  // islands. Adding the derived edges below can only merge components, never
  // split them, so a product already connected on its stored mappings can never
  // be islanded — skip it. This keeps the USDA fetch to the small flagged subset.
  const candidates = productsWithMappings.filter(
    (prod) =>
      prod.unitMappings.length >= 2 &&
      !isMiscProduct(prod.name) &&
      detectIslands(prod.unitMappings, prod).length >= 2,
  );

  // Second pass: re-check each candidate against its effective mappings, dropping
  // any that the USDA/price edges bridge into a single component.
  const enriched = await batchEnrichWithFood(
    candidates,
    foodLookupParamFromProduct,
    usdaClient,
  );

  const problems: ProductWithIslandedMappings[] = [];
  for (const prod of enriched) {
    let effective: ReturnType<typeof getAllUnitMappingsFromProduct>;
    try {
      effective = getAllUnitMappingsFromProduct({
        id: prod.id,
        unitMappings: prod.unitMappings,
        food: prod.food,
        price: prod.price,
      });
    } catch (error) {
      console.error(
        `Failed to synthesize mappings for product ${prod.id} (${prod.name}):`,
        error,
      );
      continue;
    }

    const islands = detectIslands(effective, prod);
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
        coverage: {
          covered: [...conversionCoverage(effective, BASE_KINDS).covered],
        },
      });
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

// A product whose stored UPC-sourced fields have a gap (no manufacturer, no
// price, or no image) that a *fresh* UPC lookup could fill — i.e. re-importing
// from the lookup would improve the record. `gaps` flags which fields the live
// lookup can actually fill (only set when the lookup has data for them).
export interface ProductWithBetterUpcData {
  id: string;
  name: string;
  manufacturer: string;
  upc: string;
  gaps: {
    manufacturer: boolean;
    price: boolean;
    image: boolean;
  };
}

// Find products that a fresh UPC lookup could enrich. We first narrow to
// *candidates* purely from the DB — products with a UPC that already have a
// stored gap (unspecified manufacturer, null price, or no image). A
// fully-populated product never triggers a lookup. Candidate UPCs are then
// resolved in a single bulk cache-read (no per-UPC round-trips), so this stays
// cheap enough to run inside the always-on scan that also backs the navbar
// badge. The worker only returns already-cached data and never re-queries dead
// UPCs, so the scan can't burn the external lookup quota.
const findProductsWithBetterUpcData = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
): Promise<ProductWithBetterUpcData[]> => {
  const dbClient = getDb(db);

  const rows = await dbClient
    .select({
      id: product.id,
      name: product.name,
      manufacturer: product.manufacturer,
      upc: product.upc,
      price: product.price,
      hasImage: exists(
        dbClient
          .select({ id: sql`1` })
          .from(productImage)
          .where(eq(productImage.productId, product.id)),
      ),
    })
    .from(product)
    .where(and(notDeleted(product), isNotNull(product.upc)));

  // No-network candidate filter: only gappy, non-misc products need a lookup.
  const candidates = rows.filter(
    (r): r is typeof r & { upc: string } =>
      r.upc != null &&
      !isMiscProduct(r.name) &&
      (isUnspecifiedManufacturer(r.manufacturer) ||
        r.price == null ||
        !r.hasImage),
  );

  const lookups = await upcLookupClient.lookupBatch(
    candidates.map((c) => c.upc),
  );

  const problems: ProductWithBetterUpcData[] = [];
  for (const cand of candidates) {
    const lookup = lookups.get(cand.upc);
    if (!lookup) continue;

    const gaps = {
      manufacturer:
        isUnspecifiedManufacturer(cand.manufacturer) &&
        !isUnspecifiedManufacturer(lookup.manufacturer ?? lookup.brand),
      price: cand.price == null && lookup.priceDollars != null,
      image: !cand.hasImage && lookup.imageUrl != null,
    };

    if (!gaps.manufacturer && !gaps.price && !gaps.image) continue;

    problems.push({
      id: cand.id,
      name: cand.name,
      manufacturer: cand.manufacturer,
      upc: cand.upc,
      gaps,
    });
  }

  return problems;
};

interface ProblemsCount {
  byType: {
    duplicateUniqueProducts: number;
    orphanedProducts: number;
    invalidUPCs: number;
    productsWithoutMappings: number;
    ingredientsWithPartialCoverage: number;
    invalidInventoryAmounts: number;
    emptyLocations: number;
    productsWithNoImages: number;
    productsWithWrongCategory: number;
    inventoryWithStaleValuations: number;
    productsWithIslandedMappings: number;
    locationsWithoutAiDescription: number;
    staleIngredientParses: number;
    staleRecipeTotals: number;
    productsWithBetterUpcData: number;
  };
  total: number;
}

// A stored ingredient occurrence whose original raw line, re-parsed with the
// *current* parser, now differs from what's stored on any axis — name, amounts, or
// modifier — i.e. it was parsed by an older parser and a re-parse would change it.
// All drift is equal; the per-axis booleans drive only how the panel sorts/styles.
interface StaleIngredientParse {
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
// A recipe whose persisted cost/calorie rollups are out of date — `totalsComputedAt`
// is NULL because the recipe is new, was edited, or a costing input (a linked
// product's price / USDA enrichment) changed. The list shows the last-known totals
// (which may be null if never computed) so the card has something to display; the
// fix action recomputes them. See recipe-costing.service / repo/recipe/totals.
interface StaleRecipeTotals {
  recipeId: RecipeId;
  recipeName: string;
  totals: RecipeTotals | null;
}

// Stale rows only (normally 0 or a handful) — indexed by Recipe_totals_stale_idx —
// so this is cheap and never a full-table read.
const findStaleRecipeTotals = async (
  db: Database,
): Promise<StaleRecipeTotals[]> => {
  return await getDb(db)
    .select({
      recipeId: recipe.id,
      recipeName: recipe.name,
      totals: recipe.totals,
    })
    .from(recipe)
    .where(and(notDeleted(recipe), isNull(recipe.totalsComputedAt)));
};

// Distinct non-deleted recipes each product feeds into, via its linked
// ingredient (product → ingredient → recipeSectionIngredient → recipe). A
// prioritization signal for the Problems page: a data gap on a product used in
// 12 recipes matters more than one used in none. Only products that HAVE an
// ingredient are returned (with a count that may be 0); non-food products are
// omitted, so the card can tell "0 recipes" apart from "no ingredient link".
export const recipeUsageCountsByProduct = async (
  db: Database,
  productIds: string[],
): Promise<Record<string, number>> => {
  if (productIds.length === 0) return {};

  const rows = await getDb(db)
    .select({
      productId: product.id,
      count: sql<number>`count(distinct ${recipe.id})`,
    })
    .from(product)
    .leftJoin(
      recipeSectionIngredient,
      and(
        eq(recipeSectionIngredient.ingredientId, product.ingredientId),
        notDeleted(recipeSectionIngredient),
      ),
    )
    .leftJoin(
      recipeSection,
      and(
        eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
        notDeleted(recipeSection),
      ),
    )
    .leftJoin(
      recipe,
      and(eq(recipe.id, recipeSection.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(product),
        isNotNull(product.ingredientId),
        inArray(product.id, productIds.map(unsafeProductId)),
      ),
    )
    .groupBy(product.id);

  return Object.fromEntries(rows.map((r) => [r.productId, Number(r.count)]));
};

export const findAllProblemsCount = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
  usdaClient: USDAClient,
): Promise<ProblemsCount> => {
  const p = await findAllProblems(db, upcLookupClient, usdaClient);

  return {
    byType: {
      duplicateUniqueProducts: p.duplicateUniqueProducts.length,
      orphanedProducts: p.orphanedProducts.length,
      invalidUPCs: p.invalidUPCs.length,
      productsWithoutMappings: p.productsWithoutMappings.length,
      ingredientsWithPartialCoverage: p.ingredientsWithPartialCoverage.length,
      invalidInventoryAmounts: p.invalidInventoryAmounts.length,
      emptyLocations: p.emptyLocations.length,
      productsWithNoImages: p.productsWithNoImages.length,
      productsWithWrongCategory: p.productsWithWrongCategory.length,
      inventoryWithStaleValuations: p.inventoryWithStaleValuations.length,
      productsWithIslandedMappings: p.productsWithIslandedMappings.length,
      locationsWithoutAiDescription: p.locationsWithoutAiDescription.length,
      staleIngredientParses: p.staleIngredientParses.length,
      staleRecipeTotals: p.staleRecipeTotals.length,
      productsWithBetterUpcData: p.productsWithBetterUpcData.length,
    },
    total: p.totalProblems,
  };
};

// Main function to get all problems
export const findAllProblems = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
  usdaClient: USDAClient,
): Promise<AllProblems> => {
  // Run all checks in parallel for better performance
  const [
    duplicateUniqueProducts,
    orphanedProducts,
    invalidUPCs,
    productsWithoutMappings,
    ingredientsWithPartialCoverage,
    invalidInventoryAmounts,
    emptyLocations,
    productsWithNoImages,
    productsNeedingFoodCategory,
    inventoryWithStaleValuationsRaw,
    productsWithIslandedMappings,
    locationsWithoutAiDescription,
    staleIngredientParses,
    staleRecipeTotals,
    productsWithBetterUpcData,
  ] = await Promise.all([
    findDuplicateUniqueProducts(db),
    findOrphanedProducts(db),
    findInvalidUPCs(db),
    findProductsWithoutMappings(db),
    findIngredientsWithPartialCoverage(db, usdaClient),
    findInvalidInventoryAmounts(db),
    findEmptyLocations(db),
    findProductsWithNoImages(db, { excludeIngredients: true }),
    findProductsNeedingFoodCategory(db),
    findInventoryWithStaleValuations(db),
    findProductsWithIslandedMappings(db, usdaClient),
    findLocationsWithoutAiDescription(db),
    findStaleIngredientParses(db),
    findStaleRecipeTotals(db),
    findProductsWithBetterUpcData(db, upcLookupClient),
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
    ingredientsWithPartialCoverage.length +
    invalidInventoryAmounts.length +
    emptyLocations.length +
    productsWithNoImages.length +
    productsWithWrongCategory.length +
    inventoryWithStaleValuations.length +
    productsWithIslandedMappings.length +
    locationsWithoutAiDescription.length +
    staleIngredientParses.length +
    staleRecipeTotals.length +
    productsWithBetterUpcData.length;

  return {
    duplicateUniqueProducts,
    orphanedProducts,
    invalidUPCs,
    productsWithoutMappings,
    ingredientsWithPartialCoverage,
    invalidInventoryAmounts,
    emptyLocations,
    productsWithNoImages,
    productsWithWrongCategory,
    inventoryWithStaleValuations,
    productsWithIslandedMappings,
    locationsWithoutAiDescription,
    staleIngredientParses,
    staleRecipeTotals,
    productsWithBetterUpcData,
    totalProblems,
  };
};
