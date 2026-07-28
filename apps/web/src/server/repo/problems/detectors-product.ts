/**
 * Product-centric Problems detectors.
 *
 * Duplicate unique products, orphaned (no-inventory) products, products with no
 * conversion/price coverage, fresh-UPC enrichment candidates, the shared
 * effective-mapping synthesis, plus the coverage data pull, recipe-usage counts,
 * and linked-product-id lookup the service layer composes.
 */

import type { IngredientId, ProductId } from "@cubby/schemas/identifiers";
import { unsafeProductId } from "@cubby/schemas/identifiers";
import type {
  DuplicateUniqueProduct,
  OrphanedProduct,
  ProductMissingPrice,
  ProductWithBetterUpcData,
  ProductWithoutMappings,
} from "@cubby/schemas/problems";
import { isMiscProduct, isNonFoodCategory } from "@cubby/shared";
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
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import type { Database } from "~/server/db";
import {
  inventoryEntry,
  product,
  productImage,
  productUnitMappings,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

// ProductWithBetterUpcData is re-exported from the package barrel for the
// Problems-page components that import it from there.
export type { ProductWithBetterUpcData };

type ProductWithUpcGapCandidate = {
  id: ProductId;
  name: string;
  manufacturer: string;
  upc: string;
  price: number | null;
  hasImage: boolean;
};

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

// Find products that have no *live* inventory entries.
//
// The `notDeleted(inventoryEntry)` inside the subquery is load-bearing: without
// it a soft-deleted entry still satisfies EXISTS, so a product whose inventory
// was deleted (rather than never created) stays invisible here — which is the
// common case, since emptying a shelf soft-deletes the row instead of removing
// it. That blind spot hid 18 of the 20 genuinely-uninventoried products.
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
            .where(
              and(
                eq(inventoryEntry.productId, product.id),
                notDeleted(inventoryEntry),
              ),
            ),
        ),
      ),
    );

  return orphaned;
};

// Find stocked products with no `price`.
//
// `inventoryEntry.valuation` is precomputed as `amount.value * product.price`,
// so a null price yields a null valuation and the location rollup silently
// omits the item. Keyed off `product.price` (the cause) rather than
// `inventoryEntry.valuation` (the symptom, which can lag a recompute).
//
// Returned partitioned, not as one list: a `misc:` bucket is a heterogeneous
// pile with no meaningful unit price and is *expected* to be unpriced — the
// per-location summary already treats those as `miscNoPrice` rather than
// `missingPricing`. Folding them in would leave the section permanently red.
export const findProductsMissingPrice = async (
  db: Database,
): Promise<{
  real: ProductMissingPrice[];
  buckets: ProductMissingPrice[];
}> => {
  const dbClient = getDb(db);

  const stockedWithoutPrice = await dbClient.query.product.findMany({
    where: and(notDeleted(product), isNull(product.price)),
    columns: { id: true, name: true, manufacturer: true },
    with: {
      inventoryEntry: {
        where: notDeleted(inventoryEntry),
        columns: { id: true, amount: true },
        with: { location: { columns: { id: true, name: true } } },
      },
    },
  });

  const real: ProductMissingPrice[] = [];
  const buckets: ProductMissingPrice[] = [];

  for (const prod of stockedWithoutPrice) {
    // Products with no live inventory contribute nothing to any rollup, so an
    // absent price costs nothing — `findOrphanedProducts` already covers them.
    if (prod.inventoryEntry.length === 0) continue;

    const item: ProductMissingPrice = {
      id: prod.id,
      name: prod.name,
      manufacturer: prod.manufacturer,
      inventoryQuantity: prod.inventoryEntry.reduce(
        (sum, entry) => sum + entry.amount.value,
        0,
      ),
      locations: prod.inventoryEntry.map((entry) => ({
        id: entry.location.id,
        name: entry.location.name,
      })),
    };

    if (isMiscProduct(prod.name)) {
      buckets.push(item);
    } else {
      real.push(item);
    }
  }

  return { real, buckets };
};

// Find products with invalid or duplicate UPC codes
// Find products with no conversion/price coverage at all. A product is covered
// if it has a manual unit mapping OR a price (synthesizes a `1 each = $price`
// edge) OR a USDA link (fdc_id/upc synthesizes portion/serving/nutrient
// edges). Mirrors the totals-gap classifier in lib/recipe-totals-gaps.ts.
// Excludes misc products (don't need pricing) and non-food (household/garage)
// products, for which food unit coverage is meaningless.
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
      category: product.category,
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
            .where(
              and(
                eq(productUnitMappings.productId, product.id),
                notDeleted(productUnitMappings),
              ),
            ),
        ),
      ),
    );

  // Filter out misc products (no pricing) and non-food products (no food
  // coverage meaning); category never surfaces in the result shape.
  return productsWithoutMappings
    .filter((p) => !isMiscProduct(p.name) && !isNonFoodCategory(p.category))
    .map(({ ingredientId, usdaUnavailable, category: _category, ...rest }) => ({
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

// ProductWithBetterUpcData (productWithBetterUpcDataSchema): a product whose
// stored UPC-sourced fields have a gap (no manufacturer, price, or image) that a
// *fresh* UPC lookup could fill. `proposed` carries the value the live lookup
// would write per field (null ⇒ no change), so the panel can show the actual
// before→after, not just which fields are missing.

// DB-only prefilter for ProductWithBetterUpcData. The service layer owns the UPC
// client call and proposed-value construction; the repo layer only identifies
// products with stored UPC-sourced gaps that are worth looking up.
export const findProductsWithUpcGaps = async (
  db: Database,
): Promise<ProductWithUpcGapCandidate[]> => {
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
          .where(
            and(
              eq(productImage.productId, product.id),
              notDeleted(productImage),
            ),
          ),
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

  return candidates.map((candidate) => ({
    ...candidate,
    hasImage: Boolean(candidate.hasImage),
  }));
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
      category: true,
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
