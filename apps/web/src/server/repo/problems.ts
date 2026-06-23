import type { Amount } from "@cubby/schemas/codec";
import {
  type IngredientId,
  type RecipeId,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import type {
  AllProblems,
  DuplicateUniqueProduct,
  EmptyLocation,
  IngredientWithoutProduct,
  IngredientWithPartialCoverage,
  LocationWithoutAiDescription,
  MaintenanceCounts,
  OrphanedProduct,
  ProblemsCount,
  ProductWithBetterUpcData,
  ProductWithIslandedMappings,
  ProductWithoutMappings,
  StaleIngredientParse,
} from "@cubby/schemas/problems";
import { isMiscProduct } from "@cubby/shared";
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
import { mapValues, omit, sum, uniq } from "es-toolkit";
import { BASE_KINDS, conversionCoverage } from "~/lib/conversion-coverage";
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
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { findProductsWithNoImages } from "~/server/repo/product";
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import { batchEnrichWithFood } from "~/server/services/usda-helpers";

// Every problem item type is the canonical Zod-derived shape from
// @cubby/schemas/problems (imported above) — this repo is checked against those
// rather than re-declaring parallel interfaces. EmptyLocation and
// ProductWithBetterUpcData are re-exported for the Problems-page components that
// import them from here.
export type { EmptyLocation, ProductWithBetterUpcData };

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
// Find products with no conversion/price coverage at all. A product is covered
// if it has a manual unit mapping OR a price (synthesizes a `1 each = $price`
// edge) OR a USDA link (fdc_id/upc synthesizes portion/serving/nutrient
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
        isNull(product.fdc_id),
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
      ingredientId,
    }));
};

// Synthesize a product's *effective* conversion edges (stored mappings + price
// edge + USDA portion/serving/nutrient edges) — the same set the conversion
// graph and costing engine use. Returns null (after logging) when the WASM
// synthesis throws, so callers can skip the product instead of failing the scan.
const synthesizeEffectiveMappings = (
  p: { name: string } & Parameters<typeof getAllUnitMappingsFromProduct>[0],
): ReturnType<typeof getAllUnitMappingsFromProduct> | null => {
  try {
    return getAllUnitMappingsFromProduct(p);
  } catch (error) {
    console.error(
      `Failed to synthesize mappings for product ${p.id} (${p.name}):`,
      error,
    );
    return null;
  }
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
// network for candidates that actually have a upc/fdc_id to look up.
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
      fdc_id: true,
      price: true,
      usdaUnavailable: true,
      ingredientId: true,
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
        p.fdc_id != null ||
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
    const effective = synthesizeEffectiveMappings(p);
    if (!effective) continue;

    // The query filters isNotNull(ingredientId), so this never skips; it just
    // narrows the type for the non-nullable schema field.
    if (p.ingredientId == null) continue;

    const cov = conversionCoverage(effective, BASE_KINDS);

    // Flag any food whose effective graph can't reach all four base kinds. This
    // includes the subtle case where a scalar/each price exists but isn't
    // reachable from a measure (e.g. russet potato: `1 each = $1` islanded from
    // the gram graph because no portion maps `each`→g) — money stays uncovered,
    // and the fix is to connect the price to grams (a manual `1 each = N g`).
    // `hasPrice` no longer exempts: a price you can't convert from a measure is
    // still a gap.
    const hasPrice =
      p.price != null ||
      effective.some((m) => isMoneyUnit(m.a.unit) || isMoneyUnit(m.b.unit));
    if (cov.tier === "complete") continue;

    problems.push({
      id: p.id,
      name: p.name,
      manufacturer: p.manufacturer,
      coverage: { covered: [...cov.covered] },
      hasPrice,
      hasUsdaLink: p.food != null,
      usdaUnavailable: p.usdaUnavailable ?? false,
      ingredientId: p.ingredientId,
    });
  }

  return problems;
};

// Find ingredients used in a recipe but linked to no product, so they can't be
// costed at all. This is the ingredient-side blind spot of the product-centric
// detectors above (findProductsWithoutMappings / findIngredientsWithPartialCoverage
// both require a product row to exist). Sub-recipe ingredients (recipeId set) are
// costed by their recipe, never a product, so they're excluded.
const findIngredientsWithoutProduct = async (
  db: Database,
): Promise<IngredientWithoutProduct[]> => {
  const dbClient = getDb(db);

  const rows = await dbClient
    .select({
      id: ingredient.id,
      name: ingredient.name,
      recipeCount: sql<number>`count(distinct ${recipe.id})`,
    })
    .from(ingredient)
    .innerJoin(
      recipeSectionIngredient,
      and(
        eq(recipeSectionIngredient.ingredientId, ingredient.id),
        notDeleted(recipeSectionIngredient),
      ),
    )
    .innerJoin(
      recipeSection,
      and(
        eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
        notDeleted(recipeSection),
      ),
    )
    .innerJoin(
      recipe,
      and(eq(recipe.id, recipeSection.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(ingredient),
        isNull(ingredient.recipeId),
        notExists(
          dbClient
            .select({ one: sql`1` })
            .from(product)
            .where(
              and(eq(product.ingredientId, ingredient.id), notDeleted(product)),
            ),
        ),
      ),
    )
    .groupBy(ingredient.id, ingredient.name);

  return rows.map((r) => ({ ...r, recipeCount: Number(r.recipeCount) }));
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
      fdc_id: true,
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
    const effective = synthesizeEffectiveMappings(prod);
    if (!effective) continue;

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

// ProductWithBetterUpcData (productWithBetterUpcDataSchema): a product whose
// stored UPC-sourced fields have a gap (no manufacturer, price, or image) that a
// *fresh* UPC lookup could fill. `gaps` flags which fields the live lookup can
// actually fill (only set when the lookup has data for them).

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

// StaleIngredientParse (staleIngredientParseSchema): a stored ingredient
// occurrence whose original raw line, re-parsed with the *current* parser, now
// differs from what's stored on any axis (name, amounts, modifier) — parsed by an
// older parser; a re-parse would change it. All drift is equal; the per-axis
// booleans drive only how the panel sorts/styles.
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
// finds nothing stale. Returns the affected recipe ids so the caller recomputes them.
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

  const recipesAffected = uniq(stale.map((s) => s.recipeId));
  return { updated: stale.length, recipesAffected };
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

  // Counts derive mechanically from the find* arrays, so byType can never drift
  // from the set of detectors (no hand-maintained per-type list to forget).
  return {
    byType: mapValues(omit(p, ["totalProblems"]), (items) => items.length),
    total: p.totalProblems,
  };
};

// Counts for the Settings → Maintenance "N affected" dry-run. Runs only the
// detectors behind that panel's buttons — all DB/WASM, no USDA/UPC network — so
// it's far cheaper than findAllProblemsCount. Recompute is a forced full pass,
// so its number is every active recipe, not just the stale ones.
export const findMaintenanceCounts = async (
  db: Database,
): Promise<MaintenanceCounts> => {
  const [staleParses, noImages, noDescription] = await Promise.all([
    findStaleIngredientParses(db),
    findProductsWithNoImages(db, { excludeIngredients: true }),
    findLocationsWithoutAiDescription(db),
  ]);

  return {
    staleIngredientParses: staleParses.length,
    // Deliberately a SUBSET of the Problems-page productsWithNoImages count:
    // backfillUPCImages can only act on products that have a UPC to look up, so
    // this counts just those. Same canonical key, intentionally narrower number.
    productsWithNoImages: noImages.filter((p) => p.upc != null).length,
    locationsWithoutAiDescription: noDescription.length,
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
    productsWithoutMappings,
    ingredientsWithPartialCoverage,
    ingredientsWithoutProduct,
    emptyLocations,
    productsWithNoImages,
    productsWithIslandedMappings,
    locationsWithoutAiDescription,
    staleIngredientParses,
    productsWithBetterUpcData,
  ] = await Promise.all([
    findDuplicateUniqueProducts(db),
    findOrphanedProducts(db),
    findProductsWithoutMappings(db),
    findIngredientsWithPartialCoverage(db, usdaClient),
    findIngredientsWithoutProduct(db),
    findEmptyLocations(db),
    findProductsWithNoImages(db, { excludeIngredients: true }),
    findProductsWithIslandedMappings(db, usdaClient),
    findLocationsWithoutAiDescription(db),
    findStaleIngredientParses(db),
    findProductsWithBetterUpcData(db, upcLookupClient),
  ]);

  const sections = {
    duplicateUniqueProducts,
    orphanedProducts,
    productsWithoutMappings,
    ingredientsWithPartialCoverage,
    ingredientsWithoutProduct,
    emptyLocations,
    productsWithNoImages,
    productsWithIslandedMappings,
    locationsWithoutAiDescription,
    staleIngredientParses,
    productsWithBetterUpcData,
  };

  // totalProblems is the sum of every section length — derived, never
  // hand-summed, so adding a detector can't silently undercount the badge.
  return {
    ...sections,
    totalProblems: sum(Object.values(sections).map((items) => items.length)),
  };
};
