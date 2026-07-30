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
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
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
  ne,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import { isUnspecifiedManufacturer } from "~/lib/manufacturer-utils";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import type { Database, DrizzleClient } from "~/server/db";
import {
  expense,
  image,
  inventoryEntry,
  product,
  productImage,
  productUnitMappings,
  recipe,
  recipeSection,
  recipeSectionIngredient,
  task,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import {
  PRODUCT_EDGE_ROLES,
  type ProductRetainingEdgeKey,
} from "~/server/repo/product/edge-roles";

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

/**
 * Correlated `notExists` builder per retaining edge, keyed off
 * `ProductRetainingEdgeKey` (derived from `PRODUCT_EDGE_ROLES`, see
 * `~/server/repo/product/edge-roles`). `Record` over that type requires an
 * entry for every acquisition/history edge, so adding one to
 * `PRODUCT_EDGE_ROLES` is a compile error here until it's wired up — mirroring
 * `PRODUCT_RETAINING_DEPENDENTS` in `product/crud.ts`'s `deleteProducts`,
 * which reads the same map to build a different shape (`inArray` fetch +
 * `assertNoDependents`) over the same retaining edges. That's the guarantee this
 * file replaces a prose "must agree on both" comment with: the *set* of
 * edges can't drift between the two consumers, even though their SQL does.
 *
 * Each builder stays a literal `.from(<table>)` (not a generic `column.table`
 * walk) on purpose — `scripts/check-soft-delete-filters.mjs` matches incoming
 * edges by literal table identifier, so a fully-generic loop here would be
 * invisible to that guard.
 */
const PRODUCT_RETAINING_NOT_EXISTS: Record<
  ProductRetainingEdgeKey,
  (dbClient: DrizzleClient) => SQL
> = {
  "InventoryEntry.productId": (dbClient) =>
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
  // Unlike the `productIdsWithExpenses` subquery in product/crud.ts, this
  // needs no `isNotNull(expense.productId)`: that one is an uncorrelated
  // NOT IN list, where a single NULL makes the whole predicate UNKNOWN. A
  // correlated `eq` simply never matches NULL.
  "Expense.productId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(expense)
        .where(and(eq(expense.productId, product.id), notDeleted(expense))),
    ),
  "Task.subjectProductId": (dbClient) =>
    notExists(
      dbClient
        .select({ id: sql`1` })
        .from(task)
        .where(and(eq(task.subjectProductId, product.id), notDeleted(task))),
    ),
};

// Find products nothing meaningful points at — no live inventory, expense,
// task subject, or ingredient link. This drives a one-click Delete on the
// Problems page, so a false positive here is executable data loss, not noise.
//
// Two distinct traps, both of which this predicate got wrong at some point:
//
//  1. *Liveness* — the `notDeleted(...)` inside each subquery is load-bearing:
//     a soft-deleted row still satisfies EXISTS, so a product whose inventory
//     was deleted (rather than never created) stays invisible — the common
//     case, since emptying a shelf soft-deletes instead of removing. That blind
//     spot hid 18 of the 20 genuinely-uninventoried products.
//
//  2. *Completeness* — Product has several incoming FK edges, and checking only
//     some of them yields a confident wrong answer. Omitting `expense` made 32
//     of 40 flagged "orphans" false positives: a tool that was bought, logged in
//     the ledger, and later sold looks exactly like one that was never real.
//     Note the soft-delete guard script can catch (1) but by construction cannot
//     catch (2) — a missing subquery is invisible to it.
//
// Inventory/expenses prove acquisition; a task subject proves the product is
// still part of a useful work history. Those disqualify it. Metadata edges
// (productExternalId, productUnitMappings, productImage) deliberately don't:
// an ASIN or a conversion says nothing about whether the thing was ever owned.
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
        ...Object.entries(PRODUCT_EDGE_ROLES)
          .filter(([, role]) => role.kind !== "metadata")
          .map(([key]) =>
            PRODUCT_RETAINING_NOT_EXISTS[key as ProductRetainingEdgeKey](
              dbClient,
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
      // Must agree with `productIdsWithImages` in product/crud.ts, and with
      // findProductsWithNoImages in product/analytics.ts: Image is separately
      // soft-deletable from ProductImage, and a PDF is a manual, not a photo.
      // Checking ProductImage alone reads `true` for a product whose only
      // attachment is a PDF, which then gets filtered out of the candidate list
      // below and never gets the UPC lookup that would fetch it a real photo —
      // hitting tools and hardware hardest.
      hasImage: exists(
        dbClient
          .select({ id: sql`1` })
          .from(productImage)
          .innerJoin(
            image,
            and(eq(image.id, productImage.imageId), notDeleted(image)),
          )
          .where(
            and(
              eq(productImage.productId, product.id),
              notDeleted(productImage),
              ne(image.contentType, PDF_CONTENT_TYPE),
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
