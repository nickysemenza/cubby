/**
 * Denominators for the Problems page's coverage meters.
 *
 * Every other detector in this directory answers "which rows are wrong?" and
 * returns just those rows. The coverage sections need the other half of the
 * fraction — the population a backlog is measured against — and nothing else in
 * the codebase computes it. Each count here is deliberately the SAME population
 * its paired detector scans, minus that detector's failing predicate, so
 * "N of M" can't quietly compare two different sets. Four of the six now reuse
 * a data-quality check's own `expectedCondition` for that population, rather
 * than a hand-derived duplicate — the same SQL the paired `dataGaps` filter
 * scopes to.
 *
 * All plain `count(*)`s over already-indexed columns. Callers should run this
 * inside `withConnection` so the six queries share one pooled connection.
 */

import type { CoverageTotals } from "@cubby/schemas/problems";
import { and, eq, exists, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import {
  ingredient,
  inventoryEntry,
  location,
  product,
  vendor,
} from "~/server/db/schema";
import { expectedCondition } from "~/server/repo/data-quality/sql";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { stockOnly } from "~/server/repo/inventory/placement";

const COUNT = sql<number>`count(*)::int`;

const first = (rows: Array<{ count: number }>): number =>
  Number(rows[0]?.count ?? 0);

export const findCoverageTotals = async (
  db: Database,
): Promise<CoverageTotals> => {
  const dbClient = getDb(db);
  const childLocation = alias(location, "child_location");

  // Matches the `productsWithNoImages` Problem's `dataGaps=product_image`
  // population: `product_image`'s own `expected` (checks/product.ts) is
  // "has inventory" — stocked products, regardless of ingredient link.
  const products = await dbClient
    .select({ count: COUNT })
    .from(product)
    .where(
      and(notDeleted(product), expectedCondition("product", "product_image")),
    );

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

  // Matches the `location/stale-recounts` view's population: locations holding
  // live stock.
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

  // Matches the `neverVerifiedInventory` Problem's `dataGaps=inventory_verified`
  // population, per that check's own `expected` (checks/inventory.ts).
  const inventoryEntries = await dbClient
    .select({ count: COUNT })
    .from(inventoryEntry)
    .where(
      and(
        notDeleted(inventoryEntry),
        expectedCondition("inventory", "inventory_verified"),
      ),
    );

  // Matches the `ingredientsWithoutProduct` Problem's
  // `dataGaps=ingredient_product` population, per that check's own `expected`
  // (checks/ingredient.ts).
  const recipeIngredients = await dbClient
    .select({ count: COUNT })
    .from(ingredient)
    .where(
      and(
        notDeleted(ingredient),
        expectedCondition("ingredient", "ingredient_product"),
      ),
    );

  // Matches the `vendorsWithoutLogos` Problem's `dataGaps=vendor_logo`
  // population, per that check's own `expected` (checks/vendor.ts).
  const activeVendors = await dbClient
    .select({ count: COUNT })
    .from(vendor)
    .where(and(notDeleted(vendor), expectedCondition("vendor", "vendor_logo")));

  return {
    productsWithNoImages: first(products),
    emptyLocations: first(leafLocations),
    staleLocations: first(stockedLocations),
    neverVerifiedInventory: first(inventoryEntries),
    ingredientsWithoutProduct: first(recipeIngredients),
    vendorsWithPurchases: first(activeVendors),
  };
};
