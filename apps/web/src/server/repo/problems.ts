import type { Amount } from "@cubby/schemas/codec";
import type { IngredientId, ProductId } from "@cubby/schemas/identifiers";
import { unsafeProductId } from "@cubby/schemas/identifiers";
import type {
  DuplicateUniqueProduct,
  EmptyLocation,
  IngredientWithoutProduct,
  IngredientWithUnusedAliases,
  LocationWithoutAiDescription,
  OrphanedProduct,
  ProductWithBetterUpcData,
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
import { env } from "~/env";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { computeParseDrift, hasDrift } from "~/lib/parse-drift";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { computeUnusedAliases } from "~/lib/unused-aliases";
import { wasm } from "~/lib/wasm";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
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
import { TraceNames, withTrace } from "~/server/tracing";

// Every problem item type is the canonical Zod-derived shape from
// @cubby/schemas/problems (imported above) — this repo is checked against those
// rather than re-declaring parallel interfaces. EmptyLocation and
// ProductWithBetterUpcData are re-exported for the Problems-page components that
// import them from here.
export type { EmptyLocation, ProductWithBetterUpcData };

// Find products with expectedQuantity=1 that appear in multiple locations
export const findDuplicateUniqueProducts = async (
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
      inventoryEntry: {
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
      (prod) => prod.expectedQuantity === 1 && prod.inventoryEntry.length > 1,
    )
    .map((prod) => ({
      id: prod.id,
      name: prod.name,
      manufacturer: prod.manufacturer,
      expectedQuantity: prod.expectedQuantity,
      locations: prod.inventoryEntry.map((entry) => ({
        id: entry.location.id,
        name: entry.location.name,
      })),
    }));
};

// Find products that have no inventory entries
export const findOrphanedProducts = async (
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
export const findProductsWithoutMappings = async (
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
export const synthesizeEffectiveMappings = (
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

// Find ingredients used in a recipe but linked to no product, so they can't be
// costed at all. This is the ingredient-side blind spot of the product-centric
// detectors above (findProductsWithoutMappings / findIngredientsWithPartialCoverage
// both require a product row to exist). Sub-recipe ingredients (recipeId set) are
// costed by their recipe, never a product, so they're excluded.
export const findIngredientsWithoutProduct = async (
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
  //
  // selectDistinct: the SQL execution is ~6ms but marshalling every row back
  // through Hyperdrive/node-postgres on workerd costs ~0.75ms/row (6684 rows ≈
  // 5s — the dominant cost). Identical (rawLine, ingredientId) pairs are pure
  // waste here: the parse is deterministic and the target is a Set, so deduping
  // server-side (6684 → ~4231 rows) cuts both the transfer AND the parse loop by
  // ~37% with byte-identical output. The HashAggregate adds ~3ms server-side —
  // a trivial price for thousands of fewer rows over the wire.
  const lineRows = await dbClient
    .selectDistinct({
      rawLine: recipeSectionIngredient.rawLine,
      ingredientId: ingredient.id,
    })
    .from(recipeSectionIngredient)
    .innerJoin(
      ingredient,
      and(
        eq(ingredient.id, recipeSectionIngredient.ingredientId),
        // Output-neutral (computeUnusedAliases only ever checks a *live*
        // ingredient's id against the map — a deleted ingredient's id is never
        // queried), so dropping lines that resolve to soft-deleted ingredients
        // trims rows without changing the verdict, and matches the soft-delete
        // convention the second query already follows.
        notDeleted(ingredient),
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
        notDeleted(recipeSectionIngredient),
        isNotNull(recipeSectionIngredient.rawLine),
        isNull(ingredient.recipeId),
      ),
    );

  // The DB fetch above is auto-traced (drizzle instrumentation); this WASM
  // parse-sweep over every recipe line is CPU and otherwise invisible — it's the
  // suspected 30–60s. Trace it with the line count so the cost is attributable.
  const resolvedNameToIngredientIds = await withTrace(
    TraceNames.wasm("parseAliasLines"),
    async (span) => {
      const map = new Map<string, Set<string>>();
      for (const row of lineRows) {
        if (!row.rawLine) continue; // isNotNull already filtered; narrow the type
        const fresh = wasm.parse_ingredient(row.rawLine);
        const key = fresh.name.toLowerCase();
        let ids = map.get(key);
        if (!ids) {
          ids = new Set();
          map.set(key, ids);
        }
        ids.add(row.ingredientId);
      }
      span.setAttributes({
        lineCount: lineRows.length,
        distinctNames: map.size,
      });
      return map;
    },
  );

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
export const findEmptyLocations = async (
  db: Database,
): Promise<EmptyLocation[]> => {
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
export const findLocationsWithoutAiDescription = async (
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
export const findProductsWithBetterUpcData = async (
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
export const findStaleIngredientParses = async (
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
  // The DB fetch above is auto-traced; this WASM re-parse + drift diff over every
  // recipe line is the CPU sweep (suspected 30–60s). Trace it with line/stale
  // counts so the cost is attributable.
  return withTrace(TraceNames.wasm("reparseStaleLines"), async (span) => {
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
    span.setAttributes({ lineCount: rows.length, staleCount: stale.length });
    return stale;
  });
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

// DB pull shared by BOTH coverage detectors (partial-coverage + islanding):
// every non-deleted product with its stored mappings, the fields needed to
// synthesize derived edges (USDA link + price), and the linked ingredient's
// naKinds. A superset of both detectors' needs, so the service can run one scan,
// one USDA enrichment, and one effective-mapping synthesis per product instead
// of doing all of it twice (the perf win behind the always-on navbar badge).
// The coverage grading (USDA enrichment, synthesis, conversionCoverage,
// islanding) all lives in the service.
export const loadProductsForCoverage = async (db: Database) =>
  getDb(db).query.product.findMany({
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
      ingredient: { columns: { naKinds: true } },
    },
  });

// One stale recipe-line write: the values to persist plus the row to write them
// to. The service computes these (incl. the find-or-create'd ingredientId);
// applyReparsedStaleLines just commits them atomically.
export interface ReparsedStaleLineWrite {
  recipeSectionIngredientId: string;
  values: {
    amounts?: Amount[];
    modifier?: string | null;
    ingredientId?: IngredientId;
  };
}

// Persist the reparsed stale-line writes in ONE transaction (kept atomic —
// partial reparse is harmless but the single tx is cheap). The service yields
// only AROUND this call, never inside it, so the tx isn't held open across the
// stream.
export const applyReparsedStaleLines = async (
  db: Database,
  writes: ReparsedStaleLineWrite[],
): Promise<void> => {
  await withTransaction(db, async (tx) => {
    for (const w of writes) {
      await updateAndReturn(
        tx,
        recipeSectionIngredient,
        w.values,
        eq(recipeSectionIngredient.id, w.recipeSectionIngredientId),
      );
    }
  });
};

// Ids of an ingredient's non-deleted, linked products. Used by the
// deleteUnusedIngredients orchestrator to delete those products first so the
// ingredient delete's linked-product guard passes.
export const findLinkedProductIds = async (
  db: Database,
  ingredientId: IngredientId,
): Promise<ProductId[]> => {
  const linked = await getDb(db).query.product.findMany({
    where: and(eq(product.ingredientId, ingredientId), notDeleted(product)),
    columns: { id: true },
  });
  return linked.map((p) => p.id);
};

// The orchestration surface (full findAllProblems scan + cost-grouped bundles,
// USDA enrichment, cross-entity deletes, the reparse mutation) lives in the
// service layer and is imported from there directly by callers. It is NOT
// re-exported here: a repo importing from a service is a layering violation and
// created a repo → service → repo module cycle. The detectors above are the
// repo-layer primitives the service composes.
