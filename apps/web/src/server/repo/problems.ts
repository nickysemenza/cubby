import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
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
  IngredientWithUnusedAliases,
  LocationWithoutAiDescription,
  MaintenanceCounts,
  OrphanedProduct,
  ProductWithBetterUpcData,
  ProductWithIslandedMappings,
  ProductWithoutMappings,
  StaleIngredientParse,
  UnusedIngredient,
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
import { sum, uniq, uniqBy } from "es-toolkit";
import { env } from "~/env";
import {
  BASE_KINDS,
  conversionCoverage,
  gradedKinds,
} from "~/lib/conversion-coverage";
import { getErrorMessage } from "~/lib/error-utils";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { computeParseDrift, hasDrift } from "~/lib/parse-drift";
import { isMoneyUnit } from "~/lib/price-mapping-utils";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { computeUnusedAliases } from "~/lib/unused-aliases";
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
import {
  deleteIngredients,
  findOrCreateIngredient,
} from "~/server/repo/ingredient";
import {
  deleteProducts,
  findProductsWithNoImages,
} from "~/server/repo/product";
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import { batchEnrichWithFood } from "~/server/services/usda-helpers";
import { traceAll } from "~/server/tracing";

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

// Detect both coverage problems in one pass: ingredient products that are
// *under-covered* and products whose mappings *island*. Both detectors fetch
// products with their stored mappings, enrich them with USDA food, and
// synthesize effective edges — so they share one product scan, one USDA
// enrichment (the overlap deduped by the client memo), and one synthesis per
// product instead of doing all of it twice.
//
//   - partial coverage: an ingredient product with *some* coverage (so
//     findProductsWithoutMappings skips it) whose effective conversion graph
//     (stored conversions + price edge + USDA edges) still can't reach all four
//     base kinds. Money in a unit mapping counts like a scalar price.
//   - islanded mappings: a product whose *effective* mappings still split into
//     2+ components. A product islanded on its stored mappings alone but bridged
//     into one component by USDA portion/serving edges is fully convertible, so
//     it isn't flagged — mirroring the "a USDA link counts as coverage" rule in
//     findProductsWithoutMappings.
const findProductCoverageProblems = async (
  db: Database,
  usdaClient: USDAClient,
): Promise<{
  ingredientsWithPartialCoverage: IngredientWithPartialCoverage[];
  productsWithIslandedMappings: ProductWithIslandedMappings[];
}> => {
  // One scan, a superset of both detectors' needs: all non-deleted products with
  // their stored mappings + the linked ingredient's N/A opt-outs.
  const products = await getDb(db).query.product.findMany({
    where: notDeleted(product),
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
      // The linked ingredient's N/A opt-outs, so partial coverage grades only the
      // kinds that apply (a count-only item isn't flagged for a volume it never uses).
      Ingredient: { columns: { naKinds: true } },
    },
  });

  // Candidate sets are pure DB/WASM (no network). Partial coverage wants
  // ingredient products with *some* signal — truly-empty ones belong to
  // findProductsWithoutMappings. Islanded wants products whose STORED mappings
  // already split into 2+ components: adding the derived edges can only merge
  // components, never split them, so a product connected on its stored mappings
  // can never be islanded. detect_unit_mapping_islands is infallible (never throws).
  const partialCandidates = products.filter(
    (p) =>
      p.ingredientId != null &&
      !isMiscProduct(p.name) &&
      (p.price != null ||
        p.fdc_id != null ||
        p.upc != null ||
        p.unitMappings.length > 0),
  );
  const islandedCandidates = products.filter(
    (p) =>
      p.unitMappings.length >= 2 &&
      !isMiscProduct(p.name) &&
      wasm.detect_unit_mapping_islands(p.unitMappings).length >= 2,
  );

  // One USDA enrichment over the union of both candidate sets (the client memo
  // dedupes the overlap so each food is fetched once), then synthesize each
  // product's effective mappings once, keyed by id, for both detectors.
  const toEnrich = uniqBy(
    [...partialCandidates, ...islandedCandidates],
    (p) => p.id,
  );
  const enriched = await batchEnrichWithFood(
    toEnrich,
    foodLookupParamFromProduct,
    usdaClient,
  );
  const enrichedById = new Map(enriched.map((p) => [p.id, p]));
  const effectiveById = new Map(
    enriched.map((p) => [p.id, synthesizeEffectiveMappings(p)]),
  );

  const ingredientsWithPartialCoverage: IngredientWithPartialCoverage[] = [];
  for (const cand of partialCandidates) {
    const p = enrichedById.get(cand.id);
    const effective = p ? effectiveById.get(p.id) : null;
    if (!p || !effective) continue;

    // partialCandidates guarantees ingredientId != null; narrow for the
    // non-nullable schema field.
    if (p.ingredientId == null) continue;

    const applicable = gradedKinds(p.Ingredient?.naKinds);
    const cov = conversionCoverage(effective, applicable);
    if (cov.tier === "complete") continue;

    // Flag any food whose effective graph can't reach all four base kinds. This
    // includes the subtle case where a scalar/each price exists but isn't
    // reachable from a measure (e.g. russet potato: `1 each = $1` islanded from
    // the gram graph because no portion maps `each`→g) — money stays uncovered.
    // `hasPrice` no longer exempts: a price you can't convert from a measure is
    // still a gap.
    const hasPrice =
      p.price != null ||
      effective.some((m) => isMoneyUnit(m.a.unit) || isMoneyUnit(m.b.unit));

    ingredientsWithPartialCoverage.push({
      id: p.id,
      name: p.name,
      manufacturer: p.manufacturer,
      coverage: { covered: [...cov.covered], applicable: [...applicable] },
      hasPrice,
      hasUsdaLink: p.food != null,
      usdaUnavailable: p.usdaUnavailable ?? false,
      ingredientId: p.ingredientId,
    });
  }

  const productsWithIslandedMappings: ProductWithIslandedMappings[] = [];
  for (const cand of islandedCandidates) {
    const p = enrichedById.get(cand.id);
    const effective = p ? effectiveById.get(p.id) : null;
    if (!p || !effective) continue;

    const islands = wasm.detect_unit_mapping_islands(effective);
    if (islands.length >= 2) {
      productsWithIslandedMappings.push({
        id: p.id,
        name: p.name,
        manufacturer: p.manufacturer,
        islandCount: islands.length,
        islands: islands.map((units) => ({
          units: units.slice(0, 3), // Limit to first 3 units for display
          exampleUnit: units[0] ?? "unknown",
        })),
        coverage: {
          covered: [...conversionCoverage(effective, BASE_KINDS).covered],
          // Islanding is about a disconnected money/measure component, not N/A
          // dimensions — grade against all four base kinds.
          applicable: [...BASE_KINDS],
        },
      });
    }
  }

  return { ingredientsWithPartialCoverage, productsWithIslandedMappings };
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

// Find ingredients carrying ≥1 "unused" alias — one that's redundant (case-only
// dup of the name / an earlier alias) or never matched by a recipe line. We
// re-parse every live recipe line with the current parser (same machinery as
// findStaleIngredientParses) to learn which names actually resolve to which
// ingredient, then ask the pure computeUnusedAliases for the verdict per row.
// Excludes sub-recipe pointers (recipeId set), which carry system names, not aliases.
export const findIngredientsWithUnusedAliases = async (
  db: Database,
): Promise<IngredientWithUnusedAliases[]> => {
  const dbClient = getDb(db);

  // Map<lower(parsedName), Set<ingredientId>>: for each live recipe line, the
  // ingredient its re-parsed name resolved to. An alias is "matched" iff this
  // map ties its lowercased value to its own ingredient.
  const lineRows = await dbClient
    .select({
      rawLine: recipeSectionIngredient.rawLine,
      ingredientId: ingredient.id,
    })
    .from(recipeSectionIngredient)
    .innerJoin(
      ingredient,
      eq(ingredient.id, recipeSectionIngredient.ingredientId),
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
        notDeleted(recipeSectionIngredient),
        isNotNull(recipeSectionIngredient.rawLine),
        isNull(ingredient.recipeId),
      ),
    );

  const resolvedNameToIngredientIds = new Map<string, Set<string>>();
  for (const row of lineRows) {
    if (!row.rawLine) continue; // isNotNull already filtered; narrow the type
    const fresh = wasm.parse_ingredient(row.rawLine);
    const key = fresh.name.toLowerCase();
    let ids = resolvedNameToIngredientIds.get(key);
    if (!ids) {
      ids = new Set();
      resolvedNameToIngredientIds.set(key, ids);
    }
    ids.add(row.ingredientId);
  }

  // Only ingredients that actually carry aliases can have unused ones.
  const withAliases = await dbClient
    .select({
      id: ingredient.id,
      name: ingredient.name,
      aliases: ingredient.aliases,
    })
    .from(ingredient)
    .where(
      and(
        notDeleted(ingredient),
        isNull(ingredient.recipeId),
        sql`cardinality(${ingredient.aliases}) > 0`,
      ),
    );

  const problems: IngredientWithUnusedAliases[] = [];
  for (const ing of withAliases) {
    const unusedAliases = computeUnusedAliases({
      id: ing.id,
      name: ing.name,
      aliases: ing.aliases,
      resolvedNameToIngredientIds,
    });
    if (unusedAliases.length > 0) {
      problems.push({
        id: ing.id,
        name: ing.name,
        aliases: ing.aliases,
        unusedAliases,
      });
    }
  }
  return problems;
};

// Find ingredients used in NO live recipe and that aren't sub-recipe pointers —
// pure cruft. Split by whether a non-deleted product links to them: the
// "with product" set's delete must also remove those products. This is the
// inverse of findIngredientsWithoutProduct (which keeps the in-recipe ones).
export const findUnusedIngredients = async (
  db: Database,
): Promise<{
  withProduct: UnusedIngredient[];
  withoutProduct: UnusedIngredient[];
}> => {
  const dbClient = getDb(db);

  const rows = await dbClient
    .select({
      id: ingredient.id,
      name: ingredient.name,
      createdAt: ingredient.createdAt,
      products: sql<{ id: string; name: string }[]>`
        coalesce(
          json_agg(json_build_object('id', ${product.id}, 'name', ${product.name}))
            filter (where ${product.id} is not null),
          '[]'
        )`,
    })
    .from(ingredient)
    .leftJoin(
      product,
      and(eq(product.ingredientId, ingredient.id), notDeleted(product)),
    )
    .where(
      and(
        notDeleted(ingredient),
        isNull(ingredient.recipeId),
        notExists(
          dbClient
            .select({ one: sql`1` })
            .from(recipeSectionIngredient)
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
                eq(recipeSectionIngredient.ingredientId, ingredient.id),
                notDeleted(recipeSectionIngredient),
              ),
            ),
        ),
      ),
    )
    .groupBy(ingredient.id, ingredient.name, ingredient.createdAt);

  const withProduct: UnusedIngredient[] = [];
  const withoutProduct: UnusedIngredient[] = [];
  for (const row of rows) {
    (row.products.length > 0 ? withProduct : withoutProduct).push(row);
  }
  return { withProduct, withoutProduct };
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
// *fresh* UPC lookup could fill. `proposed` carries the value the live lookup
// would write per field (null ⇒ no change), so the panel can show the actual
// before→after, not just which fields are missing.

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

    // Each field is set only when a fresh lookup would fill it (stored value
    // empty AND lookup has one); null ⇒ no change. The non-null fields are
    // exactly the old `gaps` booleans, now carrying the value that would land.
    const proposed = {
      manufacturer:
        isUnspecifiedManufacturer(cand.manufacturer) &&
        !isUnspecifiedManufacturer(lookup.manufacturer ?? lookup.brand)
          ? (lookup.manufacturer ?? lookup.brand)
          : null,
      price:
        cand.price == null && lookup.priceDollars != null
          ? lookup.priceDollars
          : null,
      imageUrl:
        !cand.hasImage && lookup.imageUrl
          ? new URL(lookup.imageUrl, env.UPC_LOOKUP_API_URL).toString()
          : null,
    };

    if (
      proposed.manufacturer == null &&
      proposed.price == null &&
      proposed.imageUrl == null
    )
      continue;

    problems.push({
      id: cand.id,
      name: cand.name,
      manufacturer: cand.manufacturer,
      upc: cand.upc,
      proposed,
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
export async function* reparseStaleIngredientParses(
  db: Database,
): AsyncGenerator<
  { done: number; total: number },
  { updated: number; recipesAffected: RecipeId[] }
> {
  const stale = await findStaleIngredientParses(db);
  if (stale.length === 0) {
    yield { done: 0, total: 0 };
    return { updated: 0, recipesAffected: [] };
  }
  // The row updates run in ONE transaction (kept atomic — partial reparse is
  // harmless but the single tx is cheap), so progress is coarse: 0 → all. We
  // yield only AROUND the tx, never inside it, so the tx isn't held open across
  // the stream.
  yield { done: 0, total: stale.length };

  // Resolve every drifted name up front, in parallel on the pool and deduped to
  // one find-or-create per distinct name. This pulls the ingredient lookups out
  // of the write transaction's serial critical path (Postgres runs one
  // statement at a time per connection, so the old interleaved
  // find-or-create + update was ~2N sequential round-trips). find-or-create is
  // race-safe and idempotent, so an ingredient resolved here but rolled back by
  // a failing tx below is harmless — a retry re-finds it.
  const driftNames = uniq(
    stale.filter((s) => s.nameDrift).map((s) => s.parsedName),
  );
  const idByName = new Map(
    await Promise.all(
      driftNames.map(
        async (name) =>
          [
            name.toLowerCase(),
            (await findOrCreateIngredient(db, name)).id,
          ] as const,
      ),
    ),
  );

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
        const id = idByName.get(row.parsedName.toLowerCase());
        if (id) values.ingredientId = id;
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
  yield { done: stale.length, total: stale.length };
  return { updated: stale.length, recipesAffected };
}

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

// Strip the given aliases (by value, case-insensitive) from each ingredient,
// leaving the ingredient itself intact. Used by both the per-card "Remove
// aliases" fix (one item) and the section's bulk "Remove all" (every item). The
// client passes exactly the aliases it rendered, so we never re-derive the set.
export const pruneUnusedAliases = async (
  db: Database,
  items: { ingredientId: IngredientId; remove: string[] }[],
): Promise<{ pruned: number }> => {
  let pruned = 0;
  await withTransaction(db, async (tx) => {
    for (const item of items) {
      if (item.remove.length === 0) continue;
      const removeLower = new Set(item.remove.map((a) => a.toLowerCase()));
      const row = await tx.query.ingredient.findFirst({
        where: and(
          eq(ingredient.id, item.ingredientId),
          notDeleted(ingredient),
        ),
        columns: { aliases: true },
      });
      if (!row) continue;
      const keep = row.aliases.filter((a) => !removeLower.has(a.toLowerCase()));
      if (keep.length === row.aliases.length) continue;
      pruned += row.aliases.length - keep.length;
      await updateAndReturn(
        tx,
        ingredient,
        { aliases: keep },
        eq(ingredient.id, item.ingredientId),
      );
    }
  });
  return { pruned };
};

// Delete unused ingredients (per-card or bulk). When `alsoDeleteProducts`, each
// ingredient's non-deleted products are deleted FIRST so deleteIngredients'
// linked-product guard passes. Processed per ingredient so one failure (e.g. a
// product with inventory → PRODUCT_HAS_INVENTORY) is reported, not fatal to the
// batch.
export const deleteUnusedIngredients = async (
  db: Database,
  ingredientIds: IngredientId[],
  alsoDeleteProducts: boolean,
  actor: ActorContext,
): Promise<{
  deleted: number;
  failed: { id: IngredientId; reason: string }[];
}> => {
  let deleted = 0;
  const failed: { id: IngredientId; reason: string }[] = [];
  for (const id of ingredientIds) {
    try {
      if (alsoDeleteProducts) {
        const linked = await getDb(db).query.product.findMany({
          where: and(eq(product.ingredientId, id), notDeleted(product)),
          columns: { id: true },
        });
        if (linked.length > 0) {
          await deleteProducts(
            db,
            linked.map((p) => p.id),
            actor,
          );
        }
      }
      await deleteIngredients(db, [id], actor);
      deleted += 1;
    } catch (error) {
      failed.push({ id, reason: getErrorMessage(error) });
    }
  }
  return { deleted, failed };
};

// Counts for the Settings → Maintenance "N affected" dry-run. Runs only the
// detectors behind that panel's buttons — all DB/WASM, no USDA/UPC network — so
// it's far cheaper than a full findAllProblems scan. Recompute is a forced full
// pass, so its number is every active recipe, not just the stale ones.
export const findMaintenanceCounts = async (
  db: Database,
): Promise<MaintenanceCounts> => {
  const r = await traceAll({
    staleIngredientParses: () => findStaleIngredientParses(db),
    productsWithNoImages: () =>
      findProductsWithNoImages(db, { excludeIngredients: true }),
    locationsWithoutAiDescription: () => findLocationsWithoutAiDescription(db),
  });

  return {
    staleIngredientParses: r.staleIngredientParses.length,
    // Deliberately a SUBSET of the Problems-page productsWithNoImages count:
    // backfillUPCImages can only act on products that have a UPC to look up, so
    // this counts just those. Same canonical key, intentionally narrower number.
    productsWithNoImages: r.productsWithNoImages.filter((p) => p.upc != null)
      .length,
    locationsWithoutAiDescription: r.locationsWithoutAiDescription.length,
  };
};

// Main function to get all problems
export const findAllProblems = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
  usdaClient: USDAClient,
): Promise<AllProblems> => {
  // Run all checks in parallel, each in its own trace span (the key names the
  // span — see traceAll). Better performance + per-detector observability.
  const r = await traceAll({
    duplicateUniqueProducts: () => findDuplicateUniqueProducts(db),
    orphanedProducts: () => findOrphanedProducts(db),
    productsWithoutMappings: () => findProductsWithoutMappings(db),
    // Both coverage detectors share one product scan + USDA enrichment.
    productCoverage: () => findProductCoverageProblems(db, usdaClient),
    ingredientsWithoutProduct: () => findIngredientsWithoutProduct(db),
    ingredientsWithUnusedAliases: () => findIngredientsWithUnusedAliases(db),
    unusedIngredients: () => findUnusedIngredients(db),
    emptyLocations: () => findEmptyLocations(db),
    productsWithNoImages: () =>
      findProductsWithNoImages(db, { excludeIngredients: true }),
    locationsWithoutAiDescription: () => findLocationsWithoutAiDescription(db),
    staleIngredientParses: () => findStaleIngredientParses(db),
    productsWithBetterUpcData: () =>
      findProductsWithBetterUpcData(db, upcLookupClient),
  });

  const sections = {
    duplicateUniqueProducts: r.duplicateUniqueProducts,
    orphanedProducts: r.orphanedProducts,
    productsWithoutMappings: r.productsWithoutMappings,
    ingredientsWithPartialCoverage:
      r.productCoverage.ingredientsWithPartialCoverage,
    ingredientsWithoutProduct: r.ingredientsWithoutProduct,
    ingredientsWithUnusedAliases: r.ingredientsWithUnusedAliases,
    unusedIngredientsWithProduct: r.unusedIngredients.withProduct,
    unusedIngredientsWithoutProduct: r.unusedIngredients.withoutProduct,
    emptyLocations: r.emptyLocations,
    productsWithNoImages: r.productsWithNoImages,
    productsWithIslandedMappings:
      r.productCoverage.productsWithIslandedMappings,
    locationsWithoutAiDescription: r.locationsWithoutAiDescription,
    staleIngredientParses: r.staleIngredientParses,
    productsWithBetterUpcData: r.productsWithBetterUpcData,
  };

  // totalProblems is the sum of every section length — derived, never
  // hand-summed, so adding a detector can't silently undercount the badge.
  return {
    ...sections,
    totalProblems: sum(Object.values(sections).map((items) => items.length)),
  };
};
