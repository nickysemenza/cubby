/**
 * Product pricing operations.
 * Price sync, stale price detection, and price backfill.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { computeProductPrice } from "~/lib/price-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { product, productUnitMappings } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { syncInventoryValuationsForProduct } from "~/server/repo/inventory/crud";

/**
 * Sync the price column for a product by recomputing from unit mappings.
 * Also syncs valuation for all inventory entries of this product.
 * This is the single function that should be called whenever unit mappings change.
 */
export const syncProductPrice = async (
  tx: DrizzleTransaction,
  productId: ProductId,
): Promise<void> => {
  // Fetch all unit mappings for this product
  const mappings = await tx.query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  // Compute the price using WASM (single source of truth)
  const price = computeProductPrice(mappings);

  // Update the product's price column
  await tx.update(product).set({ price }).where(eq(product.id, productId));

  // Update valuations for all inventory entries of this product
  await syncInventoryValuationsForProduct(tx, productId);
};

/**
 * Find all products that have stale or missing prices.
 * A price is stale if the computed price from unit mappings differs from the stored price.
 * A price is missing if the product has price mappings but no stored price.
 */
export const findProductsWithStalePrices = async (
  db: Database,
): Promise<
  Array<{
    id: string;
    name: string;
    manufacturer: string;
    storedPrice: number | null;
    computedPrice: number | null;
    status: "missing" | "stale";
  }>
> => {
  const dbClient = getDb(db);

  // Get all products with their unit mappings
  const productsWithMappings = await dbClient.query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      price: true,
    },
    with: {
      unitMappings: true,
    },
  });

  const results: Array<{
    id: string;
    name: string;
    manufacturer: string;
    storedPrice: number | null;
    computedPrice: number | null;
    status: "missing" | "stale";
  }> = [];

  for (const prod of productsWithMappings) {
    const computedPrice = computeProductPrice(prod.unitMappings);
    const storedPrice = prod.price;

    // Skip if both are null (no price mapping, no stored price)
    if (computedPrice === null && storedPrice === null) {
      continue;
    }

    // Check if price is missing or stale
    if (computedPrice !== null && storedPrice === null) {
      results.push({
        id: prod.id,
        name: prod.name,
        manufacturer: prod.manufacturer,
        storedPrice,
        computedPrice,
        status: "missing",
      });
    } else if (
      computedPrice !== null &&
      storedPrice !== null &&
      Math.abs(computedPrice - storedPrice) > 0.005
    ) {
      results.push({
        id: prod.id,
        name: prod.name,
        manufacturer: prod.manufacturer,
        storedPrice,
        computedPrice,
        status: "stale",
      });
    }
  }

  return results;
};

/**
 * Backfill product prices from unit mappings.
 * Updates all products with missing or stale prices.
 */
export const backfillProductPrices = async (
  db: Database,
  actor: ActorContext,
): Promise<{
  updated: number;
  products: Array<{
    id: string;
    name: string;
    oldPrice: number | null;
    newPrice: number | null;
  }>;
}> => {
  const productsToUpdate = await findProductsWithStalePrices(db);

  if (productsToUpdate.length === 0) {
    return { updated: 0, products: [] };
  }

  return await withTransaction(db, async (tx) => {
    const updatedProducts: Array<{
      id: string;
      name: string;
      oldPrice: number | null;
      newPrice: number | null;
    }> = [];

    for (const prod of productsToUpdate) {
      // Update the product's price
      await tx
        .update(product)
        .set({ price: prod.computedPrice })
        .where(eq(product.id, prod.id));

      // Log audit entry
      await logAuditEntry(tx, actor, {
        entityType: "product",
        entityId: prod.id,
        action: "update",
        changes: {
          price: { from: prod.storedPrice, to: prod.computedPrice },
        },
      });

      updatedProducts.push({
        id: prod.id,
        name: prod.name,
        oldPrice: prod.storedPrice,
        newPrice: prod.computedPrice,
      });
    }

    return {
      updated: updatedProducts.length,
      products: updatedProducts,
    };
  });
};
