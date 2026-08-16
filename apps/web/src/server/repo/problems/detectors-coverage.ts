/**
 * Denominators for the Problems page's coverage meters.
 *
 * Every other detector in this directory answers "which rows are wrong?" and
 * returns just those rows. The coverage sections need the other half of the
 * fraction — the population a backlog is measured against — and nothing else in
 * the codebase computes it. Each count here is deliberately the SAME population
 * its paired detector scans, minus that detector's failing predicate, so
 * "N of M" can't quietly compare two different sets.
 *
 * All plain `count(*)`s over already-indexed columns. Callers should run this
 * inside `withConnection` so the six queries share one pooled connection.
 */

import type { CoverageTotals } from "@cubby/schemas/problems";
import { and, eq, exists, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "~/server/db";
import {
  ingredient,
  inventoryEntry,
  location,
  product,
  purchase,
  recipe,
  recipeSection,
  recipeSectionIngredient,
  vendor,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { stockOnly } from "~/server/repo/inventory/placement";

const COUNT = sql<number>`count(*)::int`;

const first = (rows: Array<{ count: number }>): number =>
  Number(rows[0]?.count ?? 0);

/**
 * The six coverage denominators, keyed by the detector each pairs with.
 *
 * `unvaluedBucketProducts` has none on purpose — a misc bucket isn't a fraction
 * of anything, so that section renders as a plain list (see
 * `coverageTotalsSchema`).
 */
export const findCoverageTotals = async (
  db: Database,
): Promise<CoverageTotals> => {
  const dbClient = getDb(db);
  const childLocation = alias(location, "child_location");

  // Matches findProductsWithNoImages(_, { excludeIngredients: true }).
  const products = await dbClient
    .select({ count: COUNT })
    .from(product)
    .where(and(notDeleted(product), isNull(product.ingredientId)));

  // Matches the `location/empty-leaves` view' leaf test: no live child location.
  const leafLocations = await dbClient
    .select({ count: COUNT })
    .from(location)
    .where(
      and(
        notDeleted(location),
        notExists(
          dbClient
            .select({ one: sql`1` })
            .from(childLocation)
            .where(
              and(
                eq(childLocation.parentId, location.id),
                notDeleted(childLocation),
              ),
            ),
        ),
      ),
    );

  // Matches findStaleLocations' INNER join: locations holding live stock.
  // Leaving installed fixtures in here would permanently cap this meter below
  // 100% — a fixture never gets recounted, so it can never be "covered".
  const stockedLocations = await dbClient
    .select({ count: COUNT })
    .from(location)
    .where(
      and(
        notDeleted(location),
        exists(
          dbClient
            .select({ one: sql`1` })
            .from(inventoryEntry)
            .where(
              and(
                eq(inventoryEntry.locationId, location.id),
                notDeleted(inventoryEntry),
                stockOnly(),
              ),
            ),
        ),
      ),
    );

  // Matches the `neverVerifiedInventory` view's population — same reasoning as
  // stockedLocations above.
  const inventoryEntries = await dbClient
    .select({ count: COUNT })
    .from(inventoryEntry)
    .where(and(notDeleted(inventoryEntry), stockOnly()));

  // Matches findIngredientsWithoutProduct's population: ingredients used by at
  // least one live NON-cookbook recipe, excluding sub-recipe ingredients. The
  // cookbook exclusion is load-bearing — without it the denominator counts the
  // ~1000 EPUB-imported rows the numerator deliberately ignores, and the meter
  // would read ~98% covered while nothing had been covered at all.
  const recipeIngredients = await dbClient
    .select({ count: sql<number>`count(distinct ${ingredient.id})::int` })
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
      and(
        eq(recipe.id, recipeSection.recipeId),
        notDeleted(recipe),
        isNull(recipe.cookbookId),
      ),
    )
    .where(and(notDeleted(ingredient), isNull(ingredient.recipeId)));

  // Matches findVendorsWithoutLogos' population: live vendors referenced by at
  // least one live purchase. Expense presence is deliberately irrelevant.
  const activeVendors = await dbClient
    .select({ count: COUNT })
    .from(vendor)
    .where(
      and(
        notDeleted(vendor),
        exists(
          dbClient
            .select({ one: sql`1` })
            .from(purchase)
            .where(and(eq(purchase.vendorId, vendor.id), notDeleted(purchase))),
        ),
      ),
    );

  return {
    productsWithNoImages: first(products),
    emptyLocations: first(leafLocations),
    staleLocations: first(stockedLocations),
    neverVerifiedInventory: first(inventoryEntries),
    ingredientsWithoutProduct: first(recipeIngredients),
    vendorsWithPurchases: first(activeVendors),
  };
};
